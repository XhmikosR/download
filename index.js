import events from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import contentDisposition from 'content-disposition';
import archiveType from '@xhmikosr/archive-type';
import decompress from '@xhmikosr/decompress';
import extName from 'ext-name';
import {fileTypeFromBuffer} from 'file-type';
import filenamify from 'filenamify';
import getStream, {getStreamAsBuffer} from 'get-stream';
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

	const exts = extName.mime(header);

	return exts.length === 1 ? exts[0].ext : null;
};

const getFilename = async (response, data) => {
	const header = response.headers['content-disposition'];

	if (header) {
		const parsed = contentDisposition.parse(header);

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

const buildStream = (uri, options) => {
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

const download = async (uri, options = {}) => {
	const {stream, options: options_} = buildStream(uri, options);

	const response = await filterEvents(stream, 'response');
	const streamData = options_.got.responseType === 'buffer' ? getStreamAsBuffer(stream) : getStream(stream);
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
	const {stream} = buildStream(uri, options);
	return stream;
};

export default download;
