import {createHash} from 'node:crypto';
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
import {HttpProxyAgent, HttpsProxyAgent} from 'hpagent';

const defaultGotOptions = {
	responseType: 'buffer',
	https: {
		rejectUnauthorized: process.env.npm_config_strict_ssl !== 'false',
	},
};

const defaultPorts = {'http:': '80', 'https:': '443'};

// npm exports its config as `npm_config_<key>`, and its no-proxy key is `noproxy`
const getEnv = (...names) => {
	for (const name of names) {
		const value = process.env[name] ?? process.env[name.toUpperCase()];

		if (value) {
			return value.trim();
		}
	}

	return '';
};

const getProxyUrl = url => url.protocol === 'https:'
	? getEnv('https_proxy', 'npm_config_https_proxy', 'http_proxy', 'npm_config_proxy', 'all_proxy')
	: getEnv('http_proxy', 'npm_config_proxy', 'all_proxy');

const shouldProxy = url => {
	// npm joins a multi-entry `noproxy` with newlines, so whitespace separates too
	const entries = getEnv('no_proxy', 'npm_config_noproxy').split(/[\s,]+/).filter(Boolean);

	if (entries.includes('*')) {
		return false;
	}

	const port = url.port || defaultPorts[url.protocol];

	return !entries.some(entry => {
		const [rawHost, rawPort] = entry.replace(/^\*?\.?/, '').split(':');
		const host = rawHost.toLowerCase();

		if (rawPort && rawPort !== port) {
			return false;
		}

		return url.hostname === host || url.hostname.endsWith(`.${host}`);
	});
};

const getProxyAgents = uri => {
	const url = new URL(uri);
	const proxy = shouldProxy(url) ? getProxyUrl(url) : '';

	if (!proxy) {
		return undefined;
	}

	return {
		http: new HttpProxyAgent({proxy, keepAlive: false}),
		https: new HttpsProxyAgent({proxy, keepAlive: false}),
	};
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

const verifyHash = (data, hash) => {
	if (!hash) {
		return;
	}

	const colon = typeof hash === 'string' ? hash.indexOf(':') : -1;
	const algorithm = colon === -1 ? '' : hash.slice(0, colon);
	const value = colon === -1 ? '' : hash.slice(colon + 1);

	if (!algorithm || !value) {
		throw new Error('Invalid `hash` option, expected "<algorithm>:<hex>".');
	}

	let actual;
	try {
		actual = createHash(algorithm).update(data).digest('hex');
	} catch {
		throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	}

	if (actual.toLowerCase() !== value.toLowerCase()) {
		throw new Error(`Hash mismatch, expected ${algorithm} ${value.toLowerCase()} but got ${actual}`);
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

const download = (uri, output, options = {}) => {
	if (typeof output === 'object') {
		options = output;
		output = null;
	}

	options = {
		...options,
		got: mergeDefinedOptions({...defaultGotOptions, agent: getProxyAgents(uri)}, options.got),
		decompress: options.decompress ?? {},
	};

	const stream = got.stream(uri, options.got);

	const promise = (async () => {
		const response = await filterEvents(stream, 'response');
		const streamData = options.got.responseType === 'buffer' ? buffer(stream) : text(stream);
		const data = await streamData;

		verifyHash(data, options.hash);

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

	// eslint-disable-next-line unicorn/no-thenable
	stream.then = promise.then.bind(promise);
	stream.catch = promise.catch.bind(promise);

	return stream;
};

export default download;
