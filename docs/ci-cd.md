# CI pipeline

This repository publishes production-ready Docker images to Amazon ECR Public through a GitHub Actions workflow. Deployments are handled manually on the target infrastructure using the images produced by CI.

## Workflow overview

1. **Trigger** – The workflow in `.github/workflows/production.yml` runs on every push to the `production` branch.
2. **Authenticate with AWS** – GitHub Actions assumes the IAM role referenced by `AWS_OIDC_ROLE_ARN` via OpenID Connect.
3. **Build & publish images** – The job builds the web server (`src/web_server/Dockerfile`) and MQTT listener (`src/listener/Dockerfile`) images, tags them as `public.ecr.aws/<alias>/<repo>:<commit>` plus `:latest`, and pushes both tags to Amazon ECR Public.
4. **Report output** – The workflow writes the published image references to the run summary so operators can pull the exact digest from the EC2 host (or any other runtime environment).

## GitHub configuration

Create these repository **variables** (non-secret values):

| Variable | Example value | Description |
| --- | --- | --- |
| `AWS_ECR_PUBLIC_ALIAS` | `abcd1` | Public ECR alias (visible in the ECR console). |
| `ECR_WEB_SERVER_REPOSITORY` | `properties-market-web` | Name of the ECR Public repository for the web service image. |
| `ECR_LISTENER_REPOSITORY` | `properties-market-listener` | Name of the ECR Public repository for the listener image. |

Add this repository **secret**:

| Secret | Description |
| --- | --- |
| `AWS_OIDC_ROLE_ARN` | ARN of the IAM role assumed by GitHub Actions (must allow `ecr-public:*`). |

## AWS resources to provision

- **Amazon ECR Public** – Create two repositories (`properties-market-web` and `properties-market-listener`) under your public registry alias and enable immutable tags.
- **IAM role for GitHub Actions** – Trusts `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`) and grants permissions to authenticate against and push images to ECR Public.

## Manual deployment guide

Once CI finishes, pull and run the newly published images on the destination host:

```bash
AWS_REGION=us-east-1
ECR_ALIAS=<your-alias>
WEB_REPO=<web-repository-name>
LISTENER_REPO=<listener-repository-name>
IMAGE_TAG=<commit-sha-from-workflow>

aws ecr-public get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin public.ecr.aws

docker pull "public.ecr.aws/${ECR_ALIAS}/${WEB_REPO}:${IMAGE_TAG}"
docker pull "public.ecr.aws/${ECR_ALIAS}/${LISTENER_REPO}:${IMAGE_TAG}"
```

Launch the containers with your preferred orchestration method (e.g., a Docker Compose file kept on the server) and update them by stopping the old stack, pulling the new tags, and starting the services again.

## Operational notes

- The workflow overwrites the `:latest` tag on every successful run and also keeps a unique tag per commit for rollbacks.
- Monitor the GitHub Actions run summary to capture the exact image tags generated in each run.
