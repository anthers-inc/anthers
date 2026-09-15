// SPDX-License-Identifier: Apache-2.0
// @anthers/web-shared imports image assets, and an ambient module declaration does not cross a
// package boundary, so each app that bundles it restates that a `*.png` import is a URL string.
declare module "*.png" {
	const src: string;
	export default src;
}
