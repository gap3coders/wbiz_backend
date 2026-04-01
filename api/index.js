const { app, bootstrapApp } = require('../server');

module.exports = async (req, res) => {
  try {
    await bootstrapApp();
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'Backend initialization failed',
      detail: error.message,
    });
  }
  return app(req, res);
};
