// Electron, for the bundle (stage.mjs): what the launch modules' imports touch of it as they load, outside Electron. Nothing
// real: the Sandbox check runs no app.
const stub = new Proxy(function () {}, { get: (_t, k) => (k === '__esModule' ? false : k === 'getPath' ? () => process.cwd() : k === 'isPackaged' ? false : k === 'getVersion' ? () => '0.0.0' : stub), apply: () => stub, construct: () => stub })
module.exports = stub
