// Resolve hook: bare '@deepseek-ai/*' imports → dsh installation copies, so
// index.js can be imported outside the Host. Only the four direct imports are
// mapped; their own transitive imports resolve naturally from their real
// paths inside the installation's pnpm tree. Adjust the path if the dsh
// installation moves.
const DSH = 'file:///Users/lijg/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const ENTRIES = {
  '@deepseek-ai/schemastery': `${DSH}/schemastery/lib/index.mjs`,
  '@deepseek-ai/dsh-credentials': `${DSH}/dsh-credentials/lib/index.js`,
  '@deepseek-ai/dsh-launch-environment': `${DSH}/dsh-launch-environment/lib/index.js`,
  '@deepseek-ai/dsh-web': `${DSH}/dsh-web/lib/index.js`,
}

export async function resolve(specifier, context, next) {
  if (specifier in ENTRIES) {
    return { url: ENTRIES[specifier], shortCircuit: true }
  }
  return next(specifier, context)
}
