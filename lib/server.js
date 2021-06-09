var URL = require("url");
var http = require("http");
var cuid = require("cuid");
var Corsify = require("corsify");
var sendJson = require("send-data/json");
var ReqLogger = require("req-logger");
var healthPoint = require("healthpoint");
var HttpHashRouter = require("http-hash-router");
const { StringDecoder } = require("string_decoder");
const UrlPattern = require('url-pattern');


var redis = require("./redis");
var version = require("../package.json").version;
const { runInNewContext } = require("vm");
const { promisify } = require("util");

GET_ASYNC = promisify(redis.get).bind(redis);
SET_ASYNC = promisify(redis.set).bind(redis);

var router = HttpHashRouter();
var logger = ReqLogger({ version: version });
var health = healthPoint({ version: version }, redis.healthCheck);
var cors = Corsify({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, accept, content-type",
});

router.set("/favicon.ico", empty);



module.exports = function createServer() {
  return http.createServer(cors(handler));
};



function handler(req, res) {
  let parsedData = getQuery(req.url);
  pattern = new UrlPattern('/api/targets(/:id)')
  if (req.url === "/health") return health(req, res);
  else if (req.url === "/api/targets") return handleTargets(req, res);
  else if (pattern.match(req.url)) return handelTargetById(req, res);

  req.id = cuid();
  logger(req, res, { requestId: req.id }, function (info) {
    info.authEmail = (req.auth || {}).email;
    console.log(info);
  });
  router(req, res, { query: getQuery(req.url) }, onError.bind(null, req, res));
}


async function handleTargets(req, res) {
  if (req.method.toLowerCase() === "get") {
    redis
      .multi()
      .keys("*")
      .exec(async function (err, replies) {
        
        allData = [];
        for(let i=0;i<replies[0].length;i++){
          let data = await GET_ASYNC(replies[0][i]);
          allData.push(data);
        }
        res.writeHead(200, "ok");
        res.write(allData.toString());
        res.end("");
      });
  }

  if (req.method.toLowerCase() === "post") {
    handelPost(req, res);
  }
  
}

async function handelPost(req, res, id=null){
  let decoder = new StringDecoder("utf-8");
    let buffer = "";

    req.on("data", function (data) {
      buffer += decoder.write(data);
    });
    
    req.on("end", async function () {
      console.log(buffer);
      buffer += decoder.end();
      if(!id){
        id = Math.round(Math.random()*1000000)
      }
      let data = await JSON.parse(buffer);
      data.id = id;
      string_data = JSON.stringify(data);
      const save_result = await SET_ASYNC(id.toString(), string_data)
      const new_result = await GET_ASYNC(id.toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify(new_result));
      res.end();
    })
}


async function handelTargetById(req, res){
  pattern = new UrlPattern('/api/targets(/:id)')
  let id = pattern.match(req.url).id.toString();

  if(req.method.toLowerCase()==="get"){
    let result = await GET_ASYNC(id)
    if(result){
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify(result));
      res.end();
    }else{
      res.writeHead(400, "Not Found");
      res.write("Error getting object");
      res.end();
    }
    
  }
  if(req.method.toLowerCase()==="post"){
    const obj = await GET_ASYNC(id);
    if(obj){
      handelPost(req, res, id);
    }else{
      res.writeHead(400, "Not Found");
      res.write("Error getting object");
      res.end();
    }
  }
}



function onError(req, res, err) {
  if (!err) return;

  res.statusCode = err.statusCode || 500;
  logError(req, res, err);

  sendJson(req, res, {
    error: err.message || http.STATUS_CODES[res.statusCode],
  });
}



function logError(req, res, err) {
  if (process.env.NODE_ENV === "test") return;

  var logType = res.statusCode >= 500 ? "error" : "warn";

  console[logType](
    {
      err: err,
      requestId: req.id,
      statusCode: res.statusCode,
    },
    err.message
  );
}



function empty(req, res) {
  res.writeHead(204);
  res.end();
}



function getQuery(url) {
  return URL.parse(url, true).query; // eslint-disable-line
}
