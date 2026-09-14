// api/create-order.js
// Backward-compatible alias routing directly to api/pathao.js
const pathaoHandler = require("./pathao");

module.exports = async function handler(req, res) {
  return pathaoHandler(req, res);
};
