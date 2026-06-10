import {Buffer} from 'node:buffer';
import {randomBytes} from 'node:crypto';
import events from 'node:events';
import {access, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buffer} from 'node:stream/consumers';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {fileTypeFromBuffer} from 'file-type';
import nock from 'nock';
import decompressUnzip from '@xhmikosr/decompress-unzip';
import {download, downloadAsStream} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const removeRecursive = async filePath => rm(filePath, {force: true, recursive: true});

// Unique output dir per test so concurrent tests don't clash
const makeTempDir = async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'downloader-test-'));
	t.teardown(() => removeRecursive(dir));
	return dir;
};

const pathExists = async path => {
	try {
		await access(path);
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
		.get('/dispo-filename')
		.replyWithFile(200, path.join(__dirname, 'fixture.zip'), {
			'Content-Disposition': 'attachment; filename="from-header.txt"',
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
		.get('/mime-charset')
		.reply(200, Buffer.from('id,name\n1,alice\n'), {'Content-Type': 'text/csv; charset=utf-8'})
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
	const data = await buffer(downloadAsStream('http://foo.bar/foo.zip'));
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

test('preserves default got options when the user passes undefined', async t => {
	const data = await download('http://foo.bar/foo.zip', {got: {responseType: undefined}});
	t.true(await isZip(data));
});

test('download a very large file', async t => {
	const data = await buffer(downloadAsStream('http://foo.bar/large.bin'));
	t.is(data.length, 7_928_260);
});

test('download and rename file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', {dest: output, filename: 'bar.zip'});
	t.true(await pathExists(path.join(output, 'bar.zip')));
});

test('save file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', {dest: output});
	t.true(await pathExists(path.join(output, 'foo.zip')));
});

test('extract file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', {dest: output, extract: true});
	t.true(await pathExists(path.join(output, 'file.txt')));
});

test('extract file with decompress plugin', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', {dest: output, extract: true, decompress: {plugins: [decompressUnzip()]}});
	t.true(await pathExists(path.join(output, 'file.txt')));
});

test('extract file that is not compressed', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.js', {dest: output, extract: true});
	t.true(await pathExists(path.join(output, 'foo.js')));
});

test('extract without dest returns files', async t => {
	const files = await download('http://foo.bar/foo.zip', {extract: true});
	t.true(Array.isArray(files));
	t.true(files.length > 0);
	t.true(files.some(file => file.path === 'file.txt'));
});

test('reject the old positional dest argument', async t => {
	await t.throwsAsync(download('http://foo.bar/foo.zip', 'dist'), {instanceOf: TypeError});
});

test('downloadAsStream rejects unsupported options', t => {
	t.throws(() => downloadAsStream('http://foo.bar/foo.zip', {dest: __dirname}), {instanceOf: TypeError});
});

test('error on 404', async t => {
	await t.throwsAsync(
		download('http://foo.bar/404'),
		undefined,
		'Response code 404 (Not Found)',
	);
});

test('rename to valid filename', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo*bar.zip', {dest: output});
	t.true(await pathExists(path.join(output, 'foo!bar.zip')));
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
	const output = await makeTempDir(t);
	await download('http://foo.bar/querystring.zip?param=value', {dest: output});
	t.true(await pathExists(path.join(output, 'querystring.zip')));
});

test('use filename from content disposition header', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/dispo-filename', {dest: output});
	t.true(await pathExists(path.join(output, 'from-header.txt')));
});

test('handle filename from file type', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/filetype', {dest: output});
	t.true(await pathExists(path.join(output, 'filetype.zip')));
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
});

test('handle filename from mime type when file-type does not support it', async t => {
	const csvData = Buffer.from('id,name\n1,alice\n');
	t.is(await fileTypeFromBuffer(csvData), undefined);

	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-single', {dest: output});
	t.true(await pathExists(path.join(output, 'mime-single.csv')));
});

test('handle filename from mime type with content-type parameters', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-charset', {dest: output});
	t.true(await pathExists(path.join(output, 'mime-charset.csv')));
});

test('do not add extension from mime type when ambiguous', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-multiple', {dest: output});
	t.true(await pathExists(path.join(output, 'mime-multiple')));
});

test('do not add extension when content type is missing', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-none', {dest: output});
	t.true(await pathExists(path.join(output, 'mime-none')));
});
