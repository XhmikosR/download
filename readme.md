# download [![npm version](https://img.shields.io/npm/v/@xhmikosr/downloader?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/downloader) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/download/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/download/actions/workflows/ci.yml?query=branch%3Amaster)

> Download and extract files

*See [download-cli](https://github.com/kevva/download-cli) for the command-line version.*

## Install

```sh
npm install @xhmikosr/downloader
```

## Usage

```js
import fs from 'node:fs';
import download, {downloadAsStream} from '@xhmikosr/downloader';

(async () => {
	await download('http://unicorn.com/foo.jpg', {dest: 'dist'});

	fs.writeFileSync('dist/foo.jpg', await download('http://unicorn.com/foo.jpg'));

	const text = await download('http://unicorn.com/foo.txt', {got: {responseType: 'text'}});
	console.log(text);

	downloadAsStream('http://unicorn.com/foo.jpg').pipe(fs.createWriteStream('dist/foo.jpg'));

	await Promise.all([
		'http://unicorn.com/foo.jpg',
		'http://cats.com/dancing.gif'
	].map(url => download(url, {dest: 'dist'})));
})();
```

### Proxies

To work with proxies, read the [`got documentation`](https://github.com/sindresorhus/got#proxies).

## API

### download(url, options?)

Returns a Promise resolving to the downloaded data (or extracted file list when `extract` is enabled and no `dest` is provided).

### downloadAsStream(url, options?)

Returns a [Duplex stream](https://nodejs.org/api/stream.html#stream_class_stream_duplex) with [additional events](https://github.com/sindresorhus/got#streams-1).

#### url

Type: `string`

URL to download.

#### options

##### options.dest

Type: `string`

Directory to save the file to.

##### options.got

Type: `Object`

Same options as [`got`](https://github.com/sindresorhus/got#options).

##### options.decompress

Same options as [`decompress`](https://github.com/XhmikosR/decompress#options).

##### options.extract

* Type: `boolean`
* Default: `false`

If set to `true`, try extracting the file using [`decompress`](https://github.com/XhmikosR/decompress).

##### options.filename

Type: `string`

Name of the saved file.
