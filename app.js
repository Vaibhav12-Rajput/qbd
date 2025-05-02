const express = require('express');
const app = express();
const port = 5001;
const cors = require('cors');
require("./config/winstonConfig");

const qbdRoute = require('./routes/qbdRoute');
const configRoute = require("./routes/configRoute.js");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*'
}));

app.use('/api/qbd/', qbdRoute);
app.use('/api/config/',configRoute);

app.listen(port, () => {
  console.log(`QBD Integration app listening on port ${port}`);
});
