import events from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import contentDisposition from 'content-disposition';
import archiveType from '@xhmikosr/archive-type';
import decompress from '@xhmikosr/decompress';
import defaults from 'defaults';
import extName from 'ext-name';
import {fileTypeFromBuffer} from 'file-type';
import filenamify from 'filenamify';
import getStream from 'get-stream';
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

const filterEvents = async (name, listener) => {
	for await (const [message] of events.on(name, listener)) {
		if (message) {
			return message;
		}
	}
};

const download = (uri, output, options) => {
	if (typeof output === 'object') {
		options = output;
		output = null;
	}

	options = {
		...options,
		got: defaults(options?.got, defaultGotOptions),
		decompress: options?.decompress ?? {},
	};

	const stream = got.stream(uri, options.got);

	const promise = filterEvents(stream, 'response')
		.then(response => {
			const encoding = options.got.responseType === 'buffer' ? 'buffer' : options.got.encoding;
			return Promise.all([getStream(stream, {encoding}), response]);
		})
		.then(async ([data, response]) => {
			const hasArchiveData = options.extract && await archiveType(data);

			if (!output) {
				return hasArchiveData ? decompress(data, options.decompress) : data;
			}

			const filename = options.filename || filenamify(await getFilename(response, data));
			const outputFilepath = path.join(output, filename);

			if (hasArchiveData) {
				return decompress(data, path.dirname(outputFilepath), options.decompress);
			}

			return fs
				.mkdir(path.dirname(outputFilepath), {recursive: true})
				.then(() => fs.writeFile(outputFilepath, data))
				.then(() => data);
		});

	// eslint-disable-next-line unicorn/no-thenable
	stream.then = promise.then.bind(promise);
	stream.catch = promise.catch.bind(promise);

	return stream;
};

export default download;
