import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/", "package-lock.json"],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
			globals: globals.node,
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
		files: ["test/**/*.ts", "scripts/**/*.ts"],
		rules: {
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-floating-promises": "off",
		},
	},
	prettier,
);
