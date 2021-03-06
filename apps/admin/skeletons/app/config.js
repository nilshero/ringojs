var actions = require("./actions");
var {htmlResponse, notFoundResponse, staticResponse} = require("ringo/jsgi/response");

// Minimalistic request dispatcher - you're probably better off with a proper framework
exports.app = function(request) {
    var path = request.pathInfo.slice(1) || "index";
    // 1. resolve against actions
    if (typeof actions[path] === "function") {
        return actions[path](request);
    }
    // 2. resolve against public folder
    var resource = getResource("./public/" + path);
    if (resource.exists()) {
        return staticResponse(resource);
    }
    // 3 return 404 response
    return notFoundResponse(request.pathInfo);
}