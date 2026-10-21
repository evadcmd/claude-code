## Claude Code dev container: authentication

The container runs Claude Code authenticated with `CLAUDE_CODE_OAUTH_TOKEN`.
The token is never baked into the image or written to disk in the container.
It lives in AWS Secrets Manager, and a small wrapper (`claude.ts`) fetches it
on every launch using a dedicated, read-only IAM user, then `execve`s the real
`claude` binary with the token in its environment.

```
docker exec ... claude
  -> /opt/claude-wrap/bin/claude (shell shim)
  -> node claude.ts            (reads the secret with the claude-dev profile)
  -> execve ~/.local/bin/claude with CLAUDE_CODE_OAUTH_TOKEN set
```

### 1. Generate a long-lived token

On the host:

```
claude setup-token
```

- Requires a Pro / Max / Team / Enterprise plan.
- Prints a one-year token **once**. It only covers model requests.
- It is independent of your local `/login` session. Once the token is stored,
  you can `claude logout` on the host if you don't use Claude Code there.
- Never paste the token into chat, shell history, or files.

### 2. Store the token in Secrets Manager

AWS Console -> Secrets Manager -> Store a new secret:

- Secret type: **Other type of secret**, key/value
  - Key: `CLAUDE_CODE_OAUTH_TOKEN`
  - Value: the token from step 1
- Encryption key: the default `aws/secretsmanager` is fine.
- Secret name: `dev/claude/oauth-token` (the prefix is the environment, not a severity level)
- Region: `ap-northeast-1`

Enter the token in the Console, not with `aws secretsmanager create-secret`,
so it doesn't end up in shell history or the process list.

Copy the secret's full ARN (`arn:aws:secretsmanager:ap-northeast-1:<account-id>:secret:dev/claude/oauth-token-XXXXXX`).

### 3. Create a read-only IAM user

IAM -> Users -> Create user:

- Name: `claude-dev-reader`
- No console access, no groups, no managed policies.
- Add **one inline policy** (`read-claude-oauth-token`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-northeast-1:<account-id>:secret:dev/claude/oauth-token-XXXXXX"
    }
  ]
}
```

Use the full ARN from step 2. If you don't have it, use the
`dev/claude/oauth-token-??????` wildcard (Secrets Manager appends six random characters).
IAM permissions are a union, so don't attach anything else to this user.

Then Security credentials -> Create access key (use case: Local code / CLI).
The Secret Access Key is shown only once.

Optional: on the secret, add a resource policy that denies everyone else:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Principal": "*",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::<account-id>:user/claude-dev-reader"
        }
      }
    }
  ]
}
```

### 4. Configure the credentials on the host

Keep this profile in its own directory, so the container never sees your other profiles:

```
mkdir -p ~/.aws-claude-dev
AWS_CONFIG_FILE=~/.aws-claude-dev/config \
AWS_SHARED_CREDENTIALS_FILE=~/.aws-claude-dev/credentials \
aws configure --profile claude-dev
```

- Access Key ID / Secret Access Key: from step 3
- Default region: `ap-northeast-1`
- Output format: `json`

Check it:

```
AWS_CONFIG_FILE=~/.aws-claude-dev/config \
AWS_SHARED_CREDENTIALS_FILE=~/.aws-claude-dev/credentials \
aws sts get-caller-identity --profile claude-dev
```

The `Arn` should end in `user/claude-dev-reader`. This only proves the key is
valid; reading the secret is verified in step 6.

Don't use `aws login`, root, or admin credentials for the container.

### 5. Build the image

`package.json`:

```json
{
  "type": "module",
  "private": true,
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3"
  }
}
```

Run `npm install` once to generate `package-lock.json`. Commit both, and ignore `node_modules/`.

`claude.ts` (Node >= 22.18 runs `.ts` directly; `process.execve` needs >= 22.15):

```ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const SECRET_ID = process.env.CLAUDE_TOKEN_SECRET_ID ?? "dev/claude/oauth-token";
const KEY = "CLAUDE_CODE_OAUTH_TOKEN";
const REAL_CLAUDE = "/home/node/.local/bin/claude";

// No explicit credentials: the SDK's default chain picks up AWS_PROFILE
// and the mounted ~/.aws files.
const client = new SecretsManagerClient({});
const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
if (!SecretString) throw new Error(`${SECRET_ID} has no SecretString`);

let fields: Record<string, unknown>;
try {
  fields = JSON.parse(SecretString);
} catch {
  // Don't rethrow JSON.parse's error: its message includes the start of the secret.
  throw new Error(`${SECRET_ID} is not key/value JSON`);
}
const token = fields[KEY];
if (typeof token !== "string" || token === "") throw new Error(`${SECRET_ID} has no ${KEY}`);

process.execve(REAL_CLAUDE, [REAL_CLAUDE, ...process.argv.slice(2)], {
  ...process.env,
  CLAUDE_CODE_OAUTH_TOKEN: token,
});
```

`Dockerfile`:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/claude-wrap
COPY package.json package-lock.json claude.ts ./
RUN npm ci --omit=dev \
    && mkdir bin \
    && printf '#!/bin/sh\nexec node /opt/claude-wrap/claude.ts "$@"\n' > bin/claude \
    && chmod +x bin/claude
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/opt/claude-wrap/bin:/home/node/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AWS_REGION=ap-northeast-1
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

Never put access keys or the token in the Dockerfile or the image.

### 6. Run

```
docker run -d --name claude \
  -v ~/.aws-claude-dev:/home/node/.aws:ro \
  -e AWS_PROFILE=claude-dev \
  -v "$PWD":/workspace \
  <image>
```

or with Compose:

```yaml
services:
  claude:
    image: <image>
    volumes:
      - ~/.aws-claude-dev:/home/node/.aws:ro
      - .:/workspace
    environment:
      AWS_PROFILE: claude-dev
```

`-e` values are part of the container config, so every `docker exec` shell inherits them.

Verify end to end:

```
docker exec -it claude claude -p "say ok"
```

### Troubleshooting

| Error | Cause |
| --- | --- |
| `Could not load credentials from any providers` | Profile not found: check the mount path, `AWS_PROFILE`, and that `node` can read the file (`docker exec claude test -r /home/node/.aws/credentials && echo readable`) |
| `AccessDeniedException` | The ARN or region in the IAM policy doesn't match the secret |
| `... has no CLAUDE_CODE_OAUTH_TOKEN` | Wrong key name in the secret |
| `... is not key/value JSON` | The secret was stored as plaintext, not key/value |
| Claude returns 401 | Token expired or revoked: run `claude setup-token` again and update the secret |

### Security notes

- The IAM key is effectively as sensitive as the token: whoever holds it can read the token.
- Don't keep a `.credentials.json` (from `/login`) in the container alongside the env var.
- The agent running inside the container can read its own environment.
  Add permission deny rules (e.g. for `/proc/**` and `~/.aws/**`) if that matters to you.
- `claude logout` does **not** revoke tokens server-side. If the token leaks,
  revoke it at <https://claude.ai/settings/claude-code>, then issue a new one.
- If the access key leaks, deactivate and delete it in IAM, then create a new one.