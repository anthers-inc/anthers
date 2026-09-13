// SPDX-License-Identifier: Apache-2.0
// Bun's bundler emits imported images as hashed asset URLs (dev HMR + prod build
// alike, including when a consuming app bundles this package's source); this teaches
// TypeScript that such an import yields a URL string.
declare module "*.png" {
	const src: string;
	export default src;
}
