import {createHash} from 'node:crypto';
import events from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {Transform} from 'node:stream';
import {buffer, text} from 'node:stream/consumers';
import {parse} from 'content-disposition';
import archiveType from '@xhmikosr/archive-type';
import decompress from '@xhmikosr/decompress';
import extName from 'ext-name';
import {fileTypeFromBuffer} from 'file-type';
import filenamify from 'filenamify';
import got from 'got';

const defaultGotOptions = {
	responseType: 'buffer',
	// Abort an idle socket so a stalled server can't hang forever
	timeout: {socket: 30_000},
	https: {
		rejectUnauthorized: process.env.npm_config_strict_ssl !== 'false',
	},
	hooks: {
		beforeRedirect: [
			(options, response) => {
				// Don't carry credentials across an https -> http downgrade
				const from = response.requestUrl ?? response.url;
				if (from && new URL(from).protocol === 'https:' && options.url.protocol === 'http:') {
					delete options.headers.authorization;
					delete options.headers.cookie;
				}
			},
		],
	},
};

const getExtFromMime = response => {
	const header = response.headers['content-type'];

	if (!header) {
		return null;
	}

	const exts = extName.mime(header.split(';')[0].trim());

	return exts.length === 1 ? exts[0].ext : null;
};

const getFilename = async (response, data) => {
	const header = response.headers['content-disposition'];

	if (header) {
		const parsed = parse(header);

		if (parsed.parameters?.filename) {
			return parsed.parameters.filename;
		}
	}

	let filename = path.basename(new URL(response.requestUrl).pathname);

	if (!path.extname(filename)) {
		const fileType = await fileTypeFromBuffer(data);
		const ext = fileType?.ext || getExtFromMime(response);

		if (ext) {
			filename = `${filename}.${ext}`;
		}
	}

	return filename;
};

const filterEvents = async (emitter, event) => {
	for await (const [message] of events.on(emitter, event)) {
		if (message) {
			return message;
		}
	}
};

const parseHash = hash => {
	const colon = typeof hash === 'string' ? hash.indexOf(':') : -1;
	const algorithm = colon === -1 ? '' : hash.slice(0, colon);
	const value = colon === -1 ? '' : hash.slice(colon + 1);

	if (!algorithm || !value) {
		throw new Error('Invalid `hash` option, expected "<algorithm>:<hex>".');
	}

	try {
		return {algorithm, value, hasher: createHash(algorithm)};
	} catch {
		throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	}
};

// Hash the body as it flows so a stream consumer can't read past an unverified body;
// a mismatch errors the stream itself, not only the awaited promise.
const verifyingStream = (source, hash) => {
	let parsed;
	let parseError;

	try {
		parsed = parseHash(hash);
	} catch (error) {
		parseError = error;
	}

	const check = new Transform({
		transform(chunk, encoding, callback) {
			if (parseError) {
				callback(parseError);
				return;
			}

			parsed.hasher.update(chunk);
			callback(null, chunk);
		},
		flush(callback) {
			if (parseError) {
				callback(parseError);
				return;
			}

			const actual = parsed.hasher.digest('hex');
			if (actual.toLowerCase() !== parsed.value.toLowerCase()) {
				callback(new Error(`Hash mismatch, expected ${parsed.algorithm} ${parsed.value.toLowerCase()} but got ${actual}`));
				return;
			}

			callback();
		},
	});

	source.once('error', error => check.destroy(error));
	source.pipe(check);
	return check;
};

// Cap the buffered body so a decompression/redirect bomb can't exhaust memory
const cappingStream = (source, maxSize) => {
	let seen = 0;
	const cap = new Transform({
		transform(chunk, encoding, callback) {
			seen += chunk.length;
			if (seen > maxSize) {
				callback(new Error(`Response body exceeded the maxSize limit of ${maxSize} bytes`));
				return;
			}

			callback(null, chunk);
		},
	});

	source.once('error', error => cap.destroy(error));
	source.pipe(cap);
	return cap;
};

const mergeDefinedOptions = (defaults, overrides = {}) => {
	const merged = {...defaults};

	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged;
};

const download = (uri, output, options = {}) => {
	if (typeof output === 'object') {
		options = output;
		output = null;
	}

	options = {
		...options,
		got: mergeDefinedOptions(defaultGotOptions, options.got),
		decompress: options.decompress ?? {},
	};

	const source = got.stream(uri, options.got);
	let stream = source;
	if (options.maxSize) {
		stream = cappingStream(stream, options.maxSize);
	}

	if (options.hash) {
		stream = verifyingStream(stream, options.hash);
	}

	const promise = (async () => {
		const response = await filterEvents(source, 'response');
		const streamData = options.got.responseType === 'buffer' ? buffer(stream) : text(stream);
		const data = await streamData;

		const hasArchiveData = options.extract && await archiveType(data);

		if (!output) {
			return hasArchiveData ? decompress(data, options.decompress) : data;
		}

		const filename = options.filename || filenamify(await getFilename(response, data));
		const outputFilepath = path.join(output, filename);

		if (hasArchiveData) {
			return decompress(data, path.dirname(outputFilepath), options.decompress);
		}

		await fs.mkdir(path.dirname(outputFilepath), {recursive: true});
		await fs.writeFile(outputFilepath, data);
		return data;
	})();

	// Swallow the eager promise's rejection so a stream-only consumer can't raise an
	// unhandled rejection; callers still get it via stream.then/catch.
	promise.catch(error => error);

	// eslint-disable-next-line unicorn/no-thenable
	stream.then = promise.then.bind(promise);
	stream.catch = promise.catch.bind(promise);

	return stream;
};

export default download;
