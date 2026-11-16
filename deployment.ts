// How chain.wtf deploys FAIRGROUND: a graph-engine title, no contract of its own.
// `chain dev casino` and the developer platform both load this file and run `title`
// through the graph compiler; the chain then derives every configuration's RTP itself.
// Keep it self-contained: type imports only.
import type { DeploymentInput } from '@chain-protocol/casino-sdk';

export default {
  kind: 'graph',
  name: 'Fairground',
  title: 'src/title.ts',
  frontend: {
    framework: 'vite',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
  },
} satisfies DeploymentInput;
