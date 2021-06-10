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
  else if(req.url==="/route") return handleRoute(req, res);

  req.id = cuid();
  logger(req, res, { requestId: req.id }, function (info) {
    info.authEmail = (req.auth || {}).email;
    console.log(info);
  });
  router(req, res, { query: getQuery(req.url) }, onError.bind(null, req, res));
}


async function handleTargets(req, res) {
  if (req.method.toLowerCase() === "get") {
    let allData = [];
    let data = await getAllValues('targets');
    for(let k in data){
      dat = data[k]
      allData.push(JSON.parse(data[k]));
    }
    res.writeHead(200, "ok");
    res.write(JSON.stringify(allData));
    res.end("");
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
      const save_result = await addToRedis('targets',id,string_data);
      const new_result = await getValue('targets',id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify(new_result));
      res.end();
    })
}


async function handelTargetById(req, res){
  pattern = new UrlPattern('/api/targets(/:id)')
  let id = pattern.match(req.url).id.toString();

  if(req.method.toLowerCase()==="get"){
    let result = await getValue('targets',id);
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
    const obj = await getValue('targets',id);
    if(obj){
      handelPost(req, res, id);
    }else{
      res.writeHead(400, "Not Found");
      res.write("Error getting object");
      res.end();
    }
  }
}


async function handleRoute(req, res){
  if(req.method.toLowerCase()==="post"){
    let decoder = new StringDecoder("utf-8");
    let buffer = "";

    req.on("data", function (data) {
      buffer += decoder.write(data);
    });
    
    req.on("end", async function () {
      buffer += decoder.end();

      let UserData = await JSON.parse(buffer);

      let loc = UserData.geoState;
      let publisher = UserData.publisher;
      let date = new Date(UserData.timestamp);
      let tstamp = date.getUTCHours();
      allData = [];
      data = await getAllValues('targets');
      for(let k in data){
        dat = await JSON.parse(data[k])
        allData.push(dat);
      }
      allData = filterExpiration(allData);
      allData = filterLocation(allData, loc);
      allData = filterTime(allData, tstamp);

      if(!allData){
        errorResponse(res);
        return;
      }

      allCounts = [];
      data = await getAllValues('counts');

      for(let k in data){
        dat = await JSON.parse(data[k])
        allCounts.push(dat);
      }
      //rejectKeys = filterCount(allData);
      acceptData = filterDataCount(allData, allCounts)
      finalData = maxValueData(acceptData);
      if(finalData){
        debugger
        value = await getValue('counts', finalData.id)
        debugger
        if(value[0]){
          const result = await addToRedis('counts',finalData.id, parseInt(value[0]) + 1)
        }else{
          const result = await addToRedis('counts',finalData.id, 1 );
          const eresult = await addToRedisExpiration(finalData.id);
        }
        res.writeHead(200, 'accepted', { 'Content-Type': 'application/json' });
        res.write(JSON.stringify(finalData.url));
        res.end();
      }else{
        res.writeHead(400, 'rejected', { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({'decision':'reject'}));
        res.end();
      }
    })
  }
}

async function filterExpiration(data){
  allData = []
  for(let i=0;i<data.length;i++){
    let dat = data[i]
    debugger
    expiration = await getValue('expiration', dat.id);
    debugger
    if(expiration[0]){
      exp = parseInt(expiration[0]);
      if(exp > Date.now()){
        allData.push(dat);
      }else{
        const result1 = await removeKey('expiration', dat.id);
        const result2 = await addToRedis('counts', dat.id, 0);
      }
    }else{
      allData.push(dat);
    }
    
  }
  debugger
  return allData;
}

async function removeKey(category, key){
  return new Promise((resolve, reject)=>{
    redis.hdel(category, key, (err, reply)=>{
      if(err){
        reject(err);
      }else{
        resolve(reply);
      }
    })
  })
}

function filterLocation(data, loc){
  acceptData = [];
  
  for(let i=0;i<data.length;i++){
    let x = data[i].accept.geoState['$in'];
    if( presentIn(loc, data[i].accept.geoState['$in'])){
      acceptData.push(data[i]);
    }
  }
  return acceptData;
}


function filterTime(data, tim){
  debugger
  acceptData = [];
  for(let i=0;i<data.length;i++){
    if( presentIn(tim.toString(), data[i].accept.hour['$in'])){
      acceptData.push(dat);
    }
  }
  return acceptData;
}


function filterDataCount(data,counts){
  debugger
  adata = []
  for(let k in data){
    if(!counts[k]){
      adata.push(data[k])
    }
    else if(parseInt(data[k].maxAcceptsPerDay) > counts[k]){
      adata.push(data[k]);
    }
  }
  return adata;
}

function presentIn(val, arr){
  for(let i=0;i<arr.length;i++){
    if(val === arr[i]){
      return true;
    }
  }
  return false;
}


function addToRedis(category, key, value){
  return new Promise((resolve, reject) => {
    redis.hmset(category, {[key]:value}, (err, reply)=>{
      if(err){
        reject(err);
      }else{
        resolve(reply);
      }
    })
  })
}

function addToRedisExpiration(key){
  return new Promise((resolve, reject) => {
    expiration = Date.now()+(24*60*60*1000)
    redis.hmset('expiration', {[key]:expiration}, (err, reply)=>{
      if(err){
        reject(err);
      }else{
        resolve(reply);
      }
    })
  })
}


function getValue(category,key){
  return new Promise((resolve, reject) =>{
    redis.hmget(category, key, (err, object)=>{
      if(err){
        reject(err)
      }else{
        resolve(object);
      }
    })
  })
}

function getAllValues(category){
  return new Promise((resolve, reject)=>{
    redis.hgetall(category, (err, object)=>{
      if(err){
        reject(err);
      }else{
        resolve(object);
      }
    })
  })
}


function maxValueData(allData){
  
  if(!allData){
    return null
  }
  let data = allData[0];
  max = -9999999;
  for(let i=1;i<allData.length;i++){
    if(allData[i].value > max){
      data = allData[i]
    }
  }
  return data;
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

function errorResponse(res){
  res.writeHead(400, 'rejected', { 'Content-Type': 'application/json' });
  res.write(JSON.stringify({'decision':'reject'}));
  res.end();
}

function empty(req, res) {
  res.writeHead(204);
  res.end();
}


function getQuery(url) {
  return URL.parse(url, true).query; // eslint-disable-line
}
