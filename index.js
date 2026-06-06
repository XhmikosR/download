import events from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
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
	https: {
		rejectUnauthorized: process.env.npm_config_strict_ssl !== 'false',
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

const mergeDefinedOptions = (defaults, overrides = {}) => {
	const merged = {...defaults};

	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged;
};

const validateOptions = options => {
	if (typeof options !== 'object' || options === null) {
		throw new TypeError('The second argument must be an options object. The destination directory is `options.dest`.');
	}
};

const unsupportedStreamOptions = ['dest', 'filename', 'extract', 'decompress'];

const buildStream = (uri, options) => {
	validateOptions(options);

	const mergedOptions = {
		...options,
		got: mergeDefinedOptions(defaultGotOptions, options.got),
		decompress: options.decompress ?? {},
	};

	return {
		stream: got.stream(uri, mergedOptions.got),
		options: mergedOptions,
	};
};

export const download = async (uri, options = {}) => {
	const {stream, options: options_} = buildStream(uri, options);

	const response = await filterEvents(stream, 'response');
	const streamData = options_.got.responseType === 'buffer' ? buffer(stream) : text(stream);
	const data = await streamData;

	const hasArchiveData = options_.extract && await archiveType(data);

	if (!options_.dest) {
		return hasArchiveData ? decompress(data, options_.decompress) : data;
	}

	const filename = options_.filename || filenamify(await getFilename(response, data));
	const outputFilepath = path.join(options_.dest, filename);

	if (hasArchiveData) {
		return decompress(data, path.dirname(outputFilepath), options_.decompress);
	}

	await fs.mkdir(path.dirname(outputFilepath), {recursive: true});
	await fs.writeFile(outputFilepath, data);
	return data;
};

export const downloadAsStream = (uri, options = {}) => {
	validateOptions(options);

	for (const key of unsupportedStreamOptions) {
		if (options[key] !== undefined) {
			throw new TypeError(`\`options.${key}\` is not supported by \`downloadAsStream\`.`);
		}
	}

	const {stream} = buildStream(uri, options);
	return stream;
};
