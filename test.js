import {Buffer} from 'node:buffer';
import {createHash, randomBytes} from 'node:crypto';
import events from 'node:events';
import http from 'node:http';
import {
	access,
	mkdtemp,
	readFile,
	rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buffer} from 'node:stream/consumers';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {fileTypeFromBuffer} from 'file-type';
import nock from 'nock';
import decompressUnzip from '@xhmikosr/decompress-unzip';
import download from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function removeRecursive(filePath) {
	return rm(filePath, {force: true, recursive: true});
}

// Unique output dir per test so concurrent tests don't clash
async function makeTempDir(t) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'downloader-test-'));
	t.teardown(() => removeRecursive(dir));
	return dir;
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isZip(input) {
	const fileType = await fileTypeFromBuffer(input);
	return fileType?.mime === 'application/zip';
}

async function fixtureHash(algorithm = 'sha256') {
	return createHash(algorithm).update(await readFile(path.join(__dirname, 'fixture.zip'))).digest('hex');
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
	const data = await buffer(download('http://foo.bar/foo.zip'));
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
	const data = await buffer(download('http://foo.bar/large.bin'));
	t.is(data.length, 7_928_260);
});

test('download and rename file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', output, {filename: 'bar.zip'});
	t.true(await pathExists(path.join(output, 'bar.zip')));
});

test('save file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', output);
	t.true(await pathExists(path.join(output, 'foo.zip')));
});

test('extract file', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', output, {extract: true});
	t.true(await pathExists(path.join(output, 'file.txt')));
});

test('extract file with decompress plugin', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.zip', output, {extract: true, decompress: {plugins: [decompressUnzip()]}});
	t.true(await pathExists(path.join(output, 'file.txt')));
});

test('extract file that is not compressed', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/foo.js', output, {extract: true});
	t.true(await pathExists(path.join(output, 'foo.js')));
});

test('extract without output returns files', async t => {
	const files = await download('http://foo.bar/foo.zip', {extract: true});
	t.true(Array.isArray(files));
	t.true(files.length > 0);
	t.true(files.some(file => file.path === 'file.txt'));
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
	await download('http://foo.bar/foo*bar.zip', output);
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

test('strips credentials on an https -> http redirect downgrade', async t => {
	let sentAuth = 'unset';
	nock('https://cred.test')
		.get('/start')
		.reply(302, null, {location: 'http://cred.test/end'});
	nock('http://cred.test')
		.get('/end')
		.reply(function () {
			sentAuth = this.req.headers.authorization;
			return [200, Buffer.from('ok')];
		});

	await download('https://cred.test/start', {got: {headers: {authorization: 'secret', cookie: 'session=1'}}});
	t.is(sentAuth, undefined);
});

test('keeps credentials on a same-scheme redirect', async t => {
	let sentAuth = 'unset';
	nock('http://cred2.test')
		.get('/start')
		.reply(302, null, {location: 'http://cred2.test/end'})
		.get('/end')
		.reply(function () {
			sentAuth = this.req.headers.authorization;
			return [200, Buffer.from('ok')];
		});

	await download('http://cred2.test/start', {got: {headers: {authorization: 'secret'}}});
	t.is(sentAuth, 'secret');
});

test('handle query string', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/querystring.zip?param=value', output);
	t.true(await pathExists(path.join(output, 'querystring.zip')));
});

test('use filename from content disposition header', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/dispo-filename', output);
	t.true(await pathExists(path.join(output, 'from-header.txt')));
});

test('handle filename from file type', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/filetype', output);
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
	await download('http://foo.bar/mime-single', output);
	t.true(await pathExists(path.join(output, 'mime-single.csv')));
});

test('handle filename from mime type with content-type parameters', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-charset', output);
	t.true(await pathExists(path.join(output, 'mime-charset.csv')));
});

test('do not add extension from mime type when ambiguous', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-multiple', output);
	t.true(await pathExists(path.join(output, 'mime-multiple')));
});

test('do not add extension when content type is missing', async t => {
	const output = await makeTempDir(t);
	await download('http://foo.bar/mime-none', output);
	t.true(await pathExists(path.join(output, 'mime-none')));
});

test('verify hash', async t => {
	const data = await download('http://foo.bar/foo.zip', {hash: `sha256:${await fixtureHash()}`});
	t.true(await isZip(data));
});

test('throw on hash mismatch', async t => {
	await t.throwsAsync(
		download('http://foo.bar/foo.zip', {hash: 'sha256:dead'}),
		{message: /Hash mismatch/},
	);
});

test('throw on unsupported hash algorithm', async t => {
	await t.throwsAsync(
		download('http://foo.bar/foo.zip', {hash: 'sha999:dead'}),
		{message: /Unsupported hash algorithm/},
	);
});

test('throw on malformed hash option', async t => {
	await t.throwsAsync(
		download('http://foo.bar/foo.zip', {hash: 'noseparator'}),
		{message: /Invalid `hash` option/},
	);
	await t.throwsAsync(
		download('http://foo.bar/foo.zip', {hash: 123}),
		{message: /Invalid `hash` option/},
	);
});

test('aborts a stalled connection via the socket timeout', async t => {
	// nock can't simulate socket inactivity, so use a server that never responds
	const server = http.createServer();
	await new Promise(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	t.teardown(() => new Promise(resolve => {
		server.close(resolve);
	}));

	const {port} = server.address();
	await t.throwsAsync(
		download(`http://127.0.0.1:${port}/`, {got: {timeout: {socket: 100}}}),
		{name: 'TimeoutError'},
	);
});

test('a stream consumer sees a hash mismatch instead of unverified data', async t => {
	await t.throwsAsync(
		buffer(download('http://foo.bar/foo.zip', {hash: 'sha256:dead'})),
		{message: /Hash mismatch/},
	);
});

test('do not write a file when the hash does not match', async t => {
	const output = await makeTempDir(t);
	await t.throwsAsync(
		download('http://foo.bar/foo.zip', output, {hash: 'sha256:dead'}),
		{message: /Hash mismatch/},
	);
	t.false(await pathExists(path.join(output, 'foo.zip')));
});
