import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"fit/",
			"pi-host/",
			"extensions/",
			"tmp/",
			"node_modules/",
			"docs/*.png",
			"src/client/vendor/",
			"ui_work/vendor/",
			"package-lock.json",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/prefer-promise-reject-errors": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
		},
	},
	{
		files: ["src/client/**/*.js"],
		languageOptions: {
			globals: globals.browser,
		},
		rules: {
			"@typescript-eslint/no-misused-promises": "off",
		},
	},
	{
		files: ["src/hubStore.ts", "src/hubLive.ts", "src/hubControl.ts", "src/hubSession.ts"],
		rules: {
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/no-base-to-string": "off",
		},
	},
	{
		files: ["src/hub.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
			"prefer-rest-params": "off",
		},
	},
	{
		files: ["src/client/markdown.js"],
		rules: {
			"@typescript-eslint/unbound-method": "off",
		},
	},
	{
		files: ["src/client/render.js"],
		rules: {
			"no-control-regex": "off",
		},
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ["test/**/*.{js,ts,mjs}", "tools/**/*.mjs"],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser },
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
		},
	},
	prettier,
);
