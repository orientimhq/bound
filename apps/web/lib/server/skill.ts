/**
 * The version of @orientimhq/swap the site points agents to, and where each form of it is: the npm
 * package (the library, the `orientim` command and the MCP server), the skill folder and the Claude
 * Desktop extension, both from the version's GitHub release. The tests hold it to the installed
 * package (package.json pins it), so the site never names a version it was not built and tested with.
 */
export const SKILL_VERSION = '3.0.0';
export const PACKAGE = '@orientimhq/swap';
const REPOSITORY = 'https://github.com/orientimhq/orientim-protected-swap';
export const SKILL_RELEASE = `${REPOSITORY}/releases/tag/v${SKILL_VERSION}`;
/** orientim.mcpb, attested by the release workflow. */
export const SKILL_EXTENSION = `${REPOSITORY}/releases/download/v${SKILL_VERSION}/orientim.mcpb`;
/** SKILL.md and reference/, as the package ships them. */
export const SKILL_FOLDER = `${REPOSITORY}/tree/v${SKILL_VERSION}/skills/orientim-protected-swap`;
