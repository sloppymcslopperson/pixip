/**
 * `show_image_to_user`: the agent's deliberate way to put one local image in
 * front of the user. Pixip renders the image block; other hosts get the image
 * plus a `file://` link in the text.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SHOW_IMAGE_TOOL, showImageToUser } from "./show.ts";

const ShowImageParams = Type.Object({
	path: Type.String({ description: "Absolute path to a PNG, JPEG, GIF or WebP image file" }),
	caption: Type.Optional(Type.String({ description: "Short caption to show with the image" })),
});

export default function pixipShowImage(pi: ExtensionAPI) {
	pi.registerTool({
		name: SHOW_IMAGE_TOOL,
		label: "Show image",
		description:
			"Show one local image to the user in the conversation. Use this when the user should look at an " +
			"image (a screenshot, diagram, photo or generated graphic) instead of just reading its path. " +
			"The path must be absolute. Images up to 1 MB are shown as-is; larger files up to 20 MB are " +
			"downscaled to a thumbnail with a download link; files over 20 MB get a link only.",
		promptSnippet: "Show a local image to the user",
		promptGuidelines: [
			"Use show_image_to_user to display an image the user should look at; pass an absolute path and an optional caption.",
		],
		parameters: ShowImageParams,
		async execute(_toolCallId, params) {
			return await showImageToUser({ path: params.path, caption: params.caption });
		},
	});
}
