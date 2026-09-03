// A resolver that predates `package.json#exports` — metro 0.72, still shipped by React Native
// applications — cannot see
// the `./react` subpath and resolves this file instead. Modern resolvers never reach it: `exports`
// wins wherever it is understood. `check:bundler` keeps the two in step.
module.exports = require('./output/react.js')
