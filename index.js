import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {Buffer} from 'node:buffer';
import {Readable} from 'node:stream';
import {parse} from 'content-disposition';
import archiveType from '@xhmikosr/archive-type';
import decompress from '@xhmikosr/decompress';
import extName from 'ext-name';
import {fileTypeFromBuffer} from 'file-type';
import filenamify from 'filenamify';
import ky from 'ky';
import {Agent} from 'undici';

const strictSsl = process.env.npm_config_strict_ssl !== 'false';

let insecureDispatcher;

const getInsecureFetch = () => {
	insecureDispatcher ??= new Agent({connect: {rejectUnauthorized: false}});
	return (input, init) => fetch(input, {...init, dispatcher: insecureDispatcher});
};

const buildKyOptions = (userKyOptions = {}) => {
	const options = {...userKyOptions};

	if (!strictSsl && options.fetch === undefined) {
		options.fetch = getInsecureFetch();
	}

	return options;
};

const getExtFromMime = response => {
	const header = response.headers.get('content-type');

	if (!header) {
		return null;
	}

	const exts = extName.mime(header.split(';')[0].trim());

	return exts.length === 1 ? exts[0].ext : null;
};

const getFilename = async (response, data) => {
	const header = response.headers.get('content-disposition');

	if (header) {
		const parsed = parse(header);

		if (parsed.parameters?.filename) {
			return parsed.parameters.filename;
		}
	}

	let filename = path.basename(new URL(response.url).pathname);

	if (!path.extname(filename)) {
		const fileType = await fileTypeFromBuffer(data);
		const ext = fileType?.ext || getExtFromMime(response);

		if (ext) {
			filename = `${filename}.${ext}`;
		}
	}

	return filename;
};

const validateOptions = options => {
	if (typeof options !== 'object' || options === null) {
		throw new TypeError('The second argument must be an options object. The destination directory is `options.dest`.');
	}
};

const unsupportedStreamOptions = ['dest', 'filename', 'extract', 'decompress'];

export const download = async (uri, options = {}) => {
	validateOptions(options);

	const {responseType = 'buffer'} = options;
	const decompressOptions = options.decompress ?? {};

	const response = await ky(uri, buildKyOptions(options.ky));
	const data = responseType === 'text'
		? await response.text()
		: Buffer.from(await response.arrayBuffer());

	const hasArchiveData = options.extract && await archiveType(data);

	if (!options.dest) {
		return hasArchiveData ? decompress(data, decompressOptions) : data;
	}

	const filename = options.filename || filenamify(await getFilename(response, data));
	const outputFilepath = path.join(options.dest, filename);

	if (hasArchiveData) {
		return decompress(data, path.dirname(outputFilepath), decompressOptions);
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

	const kyOptions = buildKyOptions(options.ky);

	async function * body() {
		const response = await ky(uri, kyOptions);

		stream.emit('response', response);

		if (response.body) {
			yield * Readable.fromWeb(response.body);
		}
	}

	const stream = Readable.from(body());
	return stream;
};
