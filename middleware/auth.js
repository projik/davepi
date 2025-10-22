const jwt = require("jsonwebtoken");

const config = process.env;

const verifyToken = (bool) => {
  return (req, res, next) => {
    if (!bool) return next();
    const token = req.headers.authorization && req.headers.authorization.replace(/bearer /i, '');
    if (!token) {
      return res.status(403).send("A token is required for authentication");
    }
    try {
      const decoded = jwt.verify(token, config.TOKEN_KEY);
      req.user = decoded;
    } catch (err) {
      return res.status(401).send("Invalid Token");
    }
    return next();
  }
};

module.exports = verifyToken;