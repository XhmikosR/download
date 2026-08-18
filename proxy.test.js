// kept out of test.js because nock's ClientRequest override hangs requests
// that go through a proxy agent, and ava runs each file in its own process
import {createReadStream} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {fileTypeFromBuffer} from 'file-type';
import download from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const proxyVariables = [
	'http_proxy',
	'HTTP_PROXY',
	'https_proxy',
	'HTTPS_PROXY',
	'all_proxy',
	'ALL_PROXY',
	'no_proxy',
	'NO_PROXY',
	'npm_config_proxy',
	'npm_config_https_proxy',
	'npm_config_noproxy',
];

// unreachable on purpose, so a request that ignores NO_PROXY fails loudly
const deadProxy = 'http://127.0.0.1:1';

function setEnvironment(t, variables) {
	const saved = proxyVariables.map(name => [name, process.env[name]]);

	const clear = () => {
		for (const name of proxyVariables) {
			delete process.env[name];
		}
	};

	clear();
	Object.assign(process.env, variables);

	t.teardown(() => {
		clear();

		for (const [name, value] of saved) {
			if (value !== undefined) {
				process.env[name] = value;
			}
		}
	});
}

async function startServers(t) {
	const connects = [];

	const origin = http.createServer((request, response) => {
		createReadStream(path.join(__dirname, 'fixture.zip')).pipe(response);
	});

	const proxy = http.createServer((request, response) => {
		response.writeHead(501).end();
	});

	proxy.on('connect', (request, socket, head) => {
		connects.push(request.url);

		const [host, port] = request.url.split(':');
		const target = net.connect(Number(port), host, () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			target.write(head);
			target.pipe(socket);
			socket.pipe(target);
		});

		target.on('error', () => socket.destroy());
		socket.on('error', () => target.destroy());
	});

	await Promise.all([origin, proxy].map(server => new Promise(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	})));

	t.teardown(() => {
		origin.close();
		proxy.close();
	});

	const originPort = origin.address().port;

	return {
		connects,
		originPort,
		url: `http://127.0.0.1:${originPort}/fixture.zip`,
		proxy: `http://127.0.0.1:${proxy.address().port}`,
	};
}

async function isZip(input) {
	const fileType = await fileTypeFromBuffer(input);
	return fileType?.mime === 'application/zip';
}

// routing is asserted through `connects`, so unresolvable hosts work as targets
async function attempt(url) {
	try {
		await download(url);
	} catch {
		// only the routing matters, the request itself is expected to fail
	}
}

test.serial('HTTP_PROXY routes the download through the proxy', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, [`127.0.0.1:${servers.originPort}`]);
});

test.serial('npm_config_proxy routes the download through the proxy', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {npm_config_proxy: servers.proxy});

	t.true(await isZip(await download(servers.url)));
	t.is(servers.connects.length, 1);
});

test.serial('http_proxy takes precedence over npm_config_proxy', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {http_proxy: servers.proxy, npm_config_proxy: deadProxy});

	t.true(await isZip(await download(servers.url)));
	t.is(servers.connects.length, 1);
});

test.serial('an https target uses npm_config_https_proxy', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {npm_config_https_proxy: servers.proxy});

	await attempt('https://example.invalid/foo.zip');

	t.deepEqual(servers.connects, ['example.invalid:443']);
});

test.serial('an http target ignores https_proxy', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {https_proxy: deadProxy});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('NO_PROXY matching the host goes direct', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy, NO_PROXY: 'example.com,127.0.0.1'});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('npm_config_noproxy goes direct, including the newline-joined form', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {
		HTTP_PROXY: servers.proxy,
		npm_config_noproxy: 'example.com\n\n127.0.0.1',
	});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('NO_PROXY=* goes direct', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy, NO_PROXY: '*'});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('a NO_PROXY entry matches on a dot boundary', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy, NO_PROXY: '.example.invalid'});

	await attempt('http://sub.example.invalid/foo.zip');
	t.deepEqual(servers.connects, []);

	await attempt('http://notexample.invalid/foo.zip');
	t.deepEqual(servers.connects, ['notexample.invalid:80']);
});

test.serial('a NO_PROXY entry with a port only matches that port', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy, NO_PROXY: `127.0.0.1:${servers.originPort}`});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('a NO_PROXY entry with a different port still proxies', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy, NO_PROXY: '127.0.0.1:1'});

	t.true(await isZip(await download(servers.url)));
	t.is(servers.connects.length, 1);
});

test.serial('an empty npm_config_proxy is treated as unset', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {npm_config_proxy: ''});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});

test.serial('an explicit got agent overrides the resolved one', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {HTTP_PROXY: servers.proxy});

	t.true(await isZip(await download(servers.url, {got: {agent: {http: false, https: false}}})));
	t.deepEqual(servers.connects, []);
});

test.serial('no proxy configured goes direct', async t => {
	const servers = await startServers(t);
	setEnvironment(t, {});

	t.true(await isZip(await download(servers.url)));
	t.deepEqual(servers.connects, []);
});
