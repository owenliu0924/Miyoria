// The web server the Docker tests run inside the job, next to the browser: nothing leaves the
// machine, and the page has what the tools need (a link, a field, a button, a download).

/** A page with a link, a field, a button that changes the text, and a file to download. */
export const TEST_SERVER = `
const http = require("node:http");
const page = (title, body) => "<!doctype html><meta charset=utf-8><title>" + title + "</title><body>" + body + "</body>";
http.createServer((req, res) => {
  if (req.url === "/two") { res.end(page("第二頁", "<h1>到了第二頁</h1><p>這裡是第二頁的內容</p>")); return; }
  if (req.url === "/file") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=\\"../../report.txt\\"" });
    res.end("downloaded bytes\\n"); return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(page("首頁", "<h1>測試首頁</h1><a href=/two>去第二頁</a> <a href=/file>下載報告</a>" +
    "<input id=q placeholder=搜尋><button onclick=\\"document.getElementById('out').textContent='你好 '+document.getElementById('q').value\\">送出</button>" +
    "<p id=out>還沒送出</p>"));
}).listen(8080, "127.0.0.1");
`;
