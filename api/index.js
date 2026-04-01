const { app, bootstrapApp } = require('../server');

module.exports = async (req, res) => {
  await bootstrapApp();
  return app(req, res);
};
