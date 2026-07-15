// SPDX-License-Identifier: AGPL-3.0-or-later
// This app bundles @anthers/web-shared's source, which imports image assets (e.g. the
// shared <Logo>). Ambient module declarations don't cross package boundaries via import,
// so each consuming app restates that a `*.png` import yields a URL string. Bun's bundler
// emits the actual hashed asset at build time.
declare module "*.png" {
	const src: string;
	export default src;
}
