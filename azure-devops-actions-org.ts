import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fetch from 'node-fetch';
import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

export const createAzureRepo = createTemplateAction({
  id: 'azure:devops:create-repo',
  schema: {
    input: {
      required: ['projectName', 'repoName', 'repoType'],
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
        repoType: {
          type: 'string',
          title: 'Repository Type',
          description: 'The type of the repository',
          enum: ['application', 'infrastructure'],
        },
      },
    },
  },
  async handler(ctx) {
    const { projectName, repoName, repoType } = ctx.input;
    const token = process.env.AZURE_DEVOPS_TOKEN;

    if (!token) {
      ctx.logger.error('AZURE_DEVOPS_TOKEN is not set in the environment variables.');
      throw new Error('AZURE_DEVOPS_TOKEN is not set in the environment variables.');
    }

    if (!projectName || !repoName || !repoType) {
      throw new Error('projectName, repoName, and repoType are required');
    }

    ctx.logger.info(`Creating repository ${repoName} in project ${projectName} as ${repoType}`);

    try {
      const response = await fetch(`https://dev.azure.com/TILabs00/${projectName}/_apis/git/repositories?api-version=6.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        },
        body: JSON.stringify({ name: repoName }),
      });

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        ctx.logger.error('Received HTML response, indicating authentication or redirection issue.');
        const errorText = await response.text();
        ctx.logger.error(`Failed with HTML response: ${errorText}`);
        throw new Error('Authentication failed. Please check your Azure DevOps token and permissions.');
      }

      if (!response.ok) {
        const errorText = await response.text();
        ctx.logger.error(`Failed to create repository: ${response.statusText}, ${errorText}`);
        throw new Error(`Failed to create repository: ${response.statusText}, ${errorText}`);
      }

      const data = await response.json();
      const newRepoUrl = `https://${token}@dev.azure.com/TILabs00/${projectName}/_git/${repoName}`;
      const templateRepoUrl = repoType === 'application' 
        ? `https://${token}@dev.azure.com/TILabs00/ArgoCD/_git/template-repo-application`
        : `https://${token}@dev.azure.com/TILabs00/ArgoCD/_git/template-repo-infra`;

      // Diretório temporário para clonar o repositório
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
      ctx.logger.info(`Cloning template repository to ${tempDir}`);

      // Inicializando o repositório localmente
      const git = simpleGit(tempDir);
      await git.clone(templateRepoUrl, tempDir);

      // Removendo o diretório .git para resetar a origem
      fs.rmSync(path.join(tempDir, '.git'), { recursive: true, force: true });

      // Inicializando um novo repositório
      await git.init();

      // Adicionando o README.md
      const readmeContent = repoType === 'application' ? 'Aplicação' : 'Infraestrutura';
      fs.writeFileSync(path.join(tempDir, 'README.md'), readmeContent);

      // Adicionando origem remota, commit e push
      await git.addRemote('origin', newRepoUrl);
      await git.add('./*');
      await git.commit('Initial commit with README.md and template content');
      await git.push('origin', 'master');

      ctx.logger.info(`Repository ${repoName} created successfully in project ${projectName} with README.md`);

      // Criar e configurar o pipeline no Azure DevOps
      const pipelineResponse = await fetch(`https://dev.azure.com/TILabs00/${projectName}/_apis/pipelines?api-version=6.0-preview.1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        },
        body: JSON.stringify({
          name: `${repoName}-pipeline`,
          configuration: {
            type: "yaml",
            path: "azure-pipelines.yaml",
            repository: {
              id: data.id,
              name: repoName,
              type: "azureReposGit",
              project: {
                id: data.project.id,
                name: projectName
              },
              refName: "refs/heads/master"
            }
          }
        }),
      });

      if (!pipelineResponse.ok) {
        const errorText = await pipelineResponse.text();
        ctx.logger.error(`Failed to create pipeline: ${pipelineResponse.statusText}, ${errorText}`);
        throw new Error(`Failed to create pipeline: ${pipelineResponse.statusText}, ${errorText}`);
      }

      ctx.logger.info(`Pipeline for repository ${repoName} created successfully.`);
    } catch (error) {
      ctx.logger.error(`Error creating repository and pipeline: ${error.message}`);
      throw error;
    }
  },
});
