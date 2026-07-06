# @xhmikosr/downloader [![npm version](https://img.shields.io/npm/v/@xhmikosr/downloader?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/downloader) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/download/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/download/actions/workflows/ci.yml?query=branch%3Amaster)

> Download and extract files

*See [download-cli](https://github.com/kevva/download-cli) for the command-line version.*

## Install

```sh
npm install @xhmikosr/downloader
```

## Usage

```js
import fs from 'node:fs';
import {download, downloadAsStream} from '@xhmikosr/downloader';

(async () => {
	await download('http://unicorn.com/foo.jpg', {dest: 'dist'});

	fs.writeFileSync('dist/foo.jpg', await download('http://unicorn.com/foo.jpg'));

	const text = await download('http://unicorn.com/foo.txt', {responseType: 'text'});
	console.log(text);

	downloadAsStream('http://unicorn.com/foo.jpg').pipe(fs.createWriteStream('dist/foo.jpg'));

	await Promise.all([
		'http://unicorn.com/foo.jpg',
		'http://cats.com/dancing.gif'
	].map(url => download(url, {dest: 'dist'})));
})();
```

### Proxies

Requests go through the global `fetch` (undici). To use a proxy, pass a custom `fetch` in `options.ky` that routes through an undici [`ProxyAgent`](https://undici.nodejs.org/#/docs/api/ProxyAgent):

```js
import {ProxyAgent} from 'undici';

const dispatcher = new ProxyAgent('http://localhost:8080');

await download('http://unicorn.com/foo.jpg', {
	dest: 'dist',
	ky: {fetch: (input, init) => fetch(input, {...init, dispatcher})},
});
```

### SSL

TLS certificate verification is enabled by default. It honors npm's [`strict-ssl`](https://docs.npmjs.com/cli/v11/using-npm/config#strict-ssl) config, so running `npm config set strict-ssl false` disables it for self-signed certificates or proxy setups. Override per call the same way, with an undici [`Agent`](https://undici.nodejs.org/#/docs/api/Agent):

```js
import {Agent} from 'undici';

const dispatcher = new Agent({connect: {rejectUnauthorized: false}});

await download('https://self-signed.example/foo.jpg', {
	dest: 'dist',
	ky: {fetch: (input, init) => fetch(input, {...init, dispatcher})},
});
```

## API

### download(url, options?)

Returns a Promise resolving to the downloaded data (or extracted file list when `extract` is enabled and no `dest` is provided).

### downloadAsStream(url, options?)

Returns a readable stream of the response body. It also emits a `response` event with the `fetch` [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response) once headers arrive, and an `error` event if the request fails.

Only performs the raw download. The `dest`, `filename`, `extract`, and `decompress` options are not supported and throw if passed; use `download` for those.

#### url

Type: `string`

URL to download.

#### options

##### options.dest

Type: `string`

Directory to save the file to.

##### options.ky

Type: `Object`

Same options as [`ky`](https://github.com/sindresorhus/ky#options).

##### options.responseType

* Type: `string`
* Default: `'buffer'`

How to read the body in `download`. Use `'text'` to resolve to a string instead of a `Buffer`. Not used by `downloadAsStream`.

##### options.decompress

Same options as [`decompress`](https://github.com/XhmikosR/decompress#options).

##### options.extract

* Type: `boolean`
* Default: `false`

If set to `true`, try extracting the file using [`decompress`](https://github.com/XhmikosR/decompress).

##### options.filename

Type: `string`

Name of the saved file.
