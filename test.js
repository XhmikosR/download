import {Buffer} from 'node:buffer';
import {randomBytes} from 'node:crypto';
import events from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import contentDisposition from 'content-disposition';
import {fileTypeFromBuffer} from 'file-type';
import {getStreamAsBuffer} from 'get-stream';
import nock from 'nock';
import decompressUnzip from '@xhmikosr/decompress-unzip';
import download, {downloadAsStream} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const removeDir = async dir => fs.rm(dir, {force: true, recursive: true});

const pathExists = async path => {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
};

async function isZip(input) {
	const fileType = await fileTypeFromBuffer(input);
	return fileType?.mime === 'application/zip';
}

test.before(() => {
	nock('http://foo.bar')
		.persist()
		.get('/404')
		.reply(404)
		.get('/foo.zip')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'))
		.get('/foo.js')
		.replyWithFile(200, __filename)
		.get('/querystring.zip').query({param: 'value'})
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'))
		.get('/dispo')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'), {
			'Content-Disposition': contentDisposition('dispo.zip'),
		})
		.get('/foo*bar.zip')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'))
		.get('/large.bin')
		.reply(200, randomBytes(7_928_260))
		.get('/redirect.zip')
		.reply(302, null, {location: 'http://foo.bar/foo.zip'})
		.get('/redirect-https.zip')
		.reply(301, null, {location: 'https://foo.bar/foo-https.zip'})
		.get('/filetype')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'))
		.get('/mime-single')
		.reply(200, Buffer.from('id,name\n1,alice\n'), {'Content-Type': 'text/csv'})
		.get('/mime-multiple')
		.reply(200, Buffer.from('plain body'), {'Content-Type': 'text/plain'})
		.get('/mime-none')
		.reply(200, Buffer.from('plain body'), {'Content-Type': ''});

	nock('https://foo.bar')
		.persist()
		.get('/foo-https.zip')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'));
});

test('download as stream', async t => {
	const data = await getStreamAsBuffer(downloadAsStream('http://foo.bar/foo.zip'));
	t.true(await isZip(data));
});

test('download as text', async t => {
	const data = await download('http://foo.bar/foo.js', {got: {responseType: 'text'}});
	t.is(typeof data, 'string');
});

test('download as promise', async t => {
	const data = await download('http://foo.bar/foo.zip');
	t.true(await isZip(data));
});

test('download a very large file', async t => {
	const data = await getStreamAsBuffer(downloadAsStream('http://foo.bar/large.bin'));
	t.is(data.length, 7_928_260);
});

test('download and rename file', async t => {
	await download('http://foo.bar/foo.zip', {dest: __dirname, filename: 'bar.zip'});
	t.true(await pathExists(path.join(__dirname, 'bar.zip')));
	await removeDir(path.join(__dirname, 'bar.zip'));
});

test('save file', async t => {
	await download('http://foo.bar/foo.zip', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'foo.zip')));
	await removeDir(path.join(__dirname, 'foo.zip'));
});

test('extract file', async t => {
	await download('http://foo.bar/foo.zip', {dest: __dirname, extract: true});
	t.true(await pathExists(path.join(__dirname, 'file.txt')));
	await removeDir(path.join(__dirname, 'file.txt'));
});

test('extract file with decompress plugin', async t => {
	await download('http://foo.bar/foo.zip', {dest: __dirname, extract: true, decompress: {plugins: [decompressUnzip()]}});
	t.true(await pathExists(path.join(__dirname, 'file.txt')));
	await removeDir(path.join(__dirname, 'file.txt'));
});

test('extract file that is not compressed', async t => {
	await download('http://foo.bar/foo.js', {dest: __dirname, extract: true});
	t.true(await pathExists(path.join(__dirname, 'foo.js')));
	await removeDir(path.join(__dirname, 'foo.js'));
});

test('extract without dest returns files', async t => {
	const files = await download('http://foo.bar/foo.zip', {extract: true});
	t.true(Array.isArray(files));
	t.true(files.length > 0);
	t.true(files.some(file => file.path === 'file.txt'));
	await removeDir(path.join(__dirname, 'file.txt'));
});

test('error on 404', async t => {
	await t.throwsAsync(
		download('http://foo.bar/404'),
		undefined,
		'Response code 404 (Not Found)',
	);
});

test('rename to valid filename', async t => {
	await download('http://foo.bar/foo*bar.zip', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'foo!bar.zip')));
	await removeDir(path.join(__dirname, 'foo!bar.zip'));
});

test('follow redirects', async t => {
	const data = await download('http://foo.bar/redirect.zip');
	t.true(await isZip(data));
});

test('follow redirect to https', async t => {
	const data = await download('http://foo.bar/redirect-https.zip');
	t.true(await isZip(data));
});

test('handle query string', async t => {
	await download('http://foo.bar/querystring.zip?param=value', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'querystring.zip')));
	await removeDir(path.join(__dirname, 'querystring.zip'));
});

test('handle content disposition', async t => {
	await download('http://foo.bar/dispo', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'dispo.zip')));
	await removeDir(path.join(__dirname, 'dispo.zip'));
});

test('handle filename from file type', async t => {
	await download('http://foo.bar/filetype', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'filetype.zip')));
	await removeDir(path.join(__dirname, 'filetype.zip'));
});

test.serial('handles falsy event payload in response listener', async t => {
	const originalOn = events.on;
	events.on = async function * () {
		yield [undefined];
	};

	t.teardown(() => {
		events.on = originalOn;
	});

	const data = await download('http://foo.bar/foo.js', {got: {responseType: 'text'}});
	t.is(typeof data, 'string');

	await removeDir(path.join(__dirname, 'foo.js'));
});

test('handle filename from mime type when file-type does not support it', async t => {
	const csvData = Buffer.from('id,name\n1,alice\n');
	t.is(await fileTypeFromBuffer(csvData), undefined);

	await download('http://foo.bar/mime-single', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'mime-single.csv')));
	await removeDir(path.join(__dirname, 'mime-single.csv'));
});

test('do not add extension from mime type when ambiguous', async t => {
	await download('http://foo.bar/mime-multiple', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'mime-multiple')));
	await removeDir(path.join(__dirname, 'mime-multiple'));
});

test('do not add extension when content type is missing', async t => {
	await download('http://foo.bar/mime-none', {dest: __dirname});
	t.true(await pathExists(path.join(__dirname, 'mime-none')));
	await removeDir(path.join(__dirname, 'mime-none'));
});
