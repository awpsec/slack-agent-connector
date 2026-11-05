import { Type } from '@sinclair/typebox';
import { registerSlackExtension } from '../src/extension-tools.mjs';

export default function slackAgent(pi) {
  registerSlackExtension(pi, Type);
}
