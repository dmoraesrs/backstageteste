// packages/backend/src/plugins/actions/create-and-register-argo-app.ts

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fetch from 'node-fetch';
import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

export const createAndRegisterArgoApp = createTemplateAction({
  id: 'argocd:create-and-register-app',
  schema: {
    input: {
      required: ['projectName', 'repoName', 'argocdUrl', 'argocdToken'],
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          title: 'Project Name',
          description: 'The name of the Azure DevOps project',
        },
        repoName: {
          type: 'string',
          title: 'Repository Name',
          description: 'The name of the repository to create',
        },
        argocdUrl: {
          type: 'string',
          title: 'ArgoCD URL',
          description: 'The URL of the ArgoCD server',
        },
        argocdToken: {
          type: 'string',
          title: 'ArgoCD Token',
          description: 'The authentication token for ArgoCD',
        },
      },
    },
  },
  async handler(ctx) {
    const { projectName, repoName, argocdUrl, argocdToken } = ctx.input;
    const token = process.env.AZURE_DEVOPS_TOKEN;

    if (!token) {
      ctx.logger.error('AZURE_DEVOPS_TOKEN is not set in the environment variables.');
      throw new Error('AZURE_DEVOPS_TOKEN is not set in the environment variables.');
    }

    ctx.logger.info(`Creating repository ${repoName} in project ${projectName}`);

    // Step 1: Create new repository in Azure DevOps
    try {
      const response = await fetch(`https://dev.azure.com/TILabs00/${projectName}/_apis/git/repositories?api-version=6.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        },
        body: JSON.stringify({ name: repoName }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        ctx.logger.error(`Failed to create repository: ${response.statusText}, ${errorText}`);
        throw new Error(`Failed to create repository: ${response.statusText}, ${errorText}`);
      }

      const data = await response.json();
      const newRepoUrl = `https://${token}@dev.azure.com/TILabs00/${projectName}/_git/${repoName}`;
      const templateRepoUrl = `https://${token}@dev.azure.com/TILabs00/ArgoCD/_git/temperature-converter-yaml`;

      // Step 2: Clone template repository
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
      ctx.logger.info(`Cloning template repository to ${tempDir}`);
      const git = simpleGit(tempDir);
      await git.clone(templateRepoUrl, tempDir);

      // Step 3: Push cloned content to new repository
      fs.rmSync(path.join(tempDir, '.git'), { recursive: true, force: true });
      await git.init();
      await git.addRemote('origin', newRepoUrl);
      await git.add('./*');
      await git.commit('Initial commit from template');
      await git.push('origin', 'master');

      ctx.logger.info(`Repository ${repoName} created successfully in project ${projectName}`);

      // Step 4: Register application in ArgoCD
      const applicationManifest = {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: {
          name: 'my-application',
          namespace: 'argocd',
        },
        spec: {
          project: 'default',
          source: {
            repoURL: newRepoUrl,
            path: 'argo-app',
            targetRevision: 'HEAD',
          },
          destination: {
            server: 'https://kubernetes.default.svc',
            namespace: 'default',
          },
          syncPolicy: {
            automated: {
              prune: true,
              selfHeal: true,
            },
          },
        },
      };

      const argoResponse = await fetch(`${argocdUrl}/api/v1/applications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${argocdToken}`,
        },
        body: JSON.stringify(applicationManifest),
      });

      if (!argoResponse.ok) {
        const errorText = await argoResponse.text();
        ctx.logger.error(`Failed to register application: ${argoResponse.statusText}, ${errorText}`);
        throw new Error(`Failed to register application: ${argoResponse.statusText}, ${errorText}`);
      }

      ctx.logger.info(`Application registered successfully in ArgoCD.`);
    } catch (error) {
      ctx.logger.error(`Error creating repository and registering application: ${error.message}`);
      throw error;
    }
  },
});
