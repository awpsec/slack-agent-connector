import { registerSlackExtension } from '../src/extension-tools.mjs';

export default function slackAgent(omp) {
  if (!omp.typebox?.Type) throw new Error('This Slack connector requires an omp version with injected TypeBox compatibility. Update omp and reload.');
  registerSlackExtension(omp, omp.typebox.Type);
}
