export const managedConfiguration: readonly string[];
export function deploymentConfigPath(): string;
export function deploymentConfigSource(directory: string, mode?: string): { path: string; environment?: string; digest: string };
export function validateDeploymentConfiguration(configuration: unknown): unknown;
export function deploy(input?: string[], override?: { account?: string; worker?: string }): Promise<void>;
