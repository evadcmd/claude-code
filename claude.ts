import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const SECRET_ID = process.env.CLAUDE_TOKEN_SECRET_ID ?? "dev/claude/oauth-token";
const KEY = "CLAUDE_CODE_OAUTH_TOKEN";
const REAL_CLAUDE = "/home/node/.local/bin/claude";

const client = new SecretsManagerClient({});
const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
if (!SecretString) throw new Error(`${SECRET_ID} has no SecretString`);

let fields: Record<string, unknown>;
try {
    fields = JSON.parse(SecretString);
} catch {
    throw new Error(`${SECRET_ID} is not key/value JSON`);
}
const token = fields[KEY];
if (typeof token !== "string" || token === "") throw new Error(`${SECRET_ID} has no ${KEY}`);

process.execve(REAL_CLAUDE, [REAL_CLAUDE, ...process.argv.slice(2)], {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: token,
});