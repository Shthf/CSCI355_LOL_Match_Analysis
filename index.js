const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require("crypto");
const querystring = require("querystring");
const path = require("path");

const port = 3000;

const { client_id, client_secret, redirect_uri, response_type, scope, access_type, grant_type } = require("./auth/credential.json");

const riot_credentials = require("./auth/riot_credentials.json");

const riot_options = {
        method: 'GET',
        headers: riot_credentials
    }
    // need to store all info using state as the index for lookup
const summoner_info_arr = []
const puuid_arr = []
const match_id_arr = []
const match_info_arr = []

const server = http.createServer();

server.on("listening", listenHandler);
server.listen(port);

function listenHandler() {
    console.log(`Now Listening on Port ${port}`);
}

server.on("request", requestHandler);

function requestHandler(req, res) {
    console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
    // console.log(req.url);

    if (req.url === "/") {
        const index_html_path = path.join(__dirname, "html", "index.html")
        const form = fs.createReadStream(index_html_path);
        res.writeHead(200, { "Content-Type": "text/html" });
        form.pipe(res);

    } else if (req.url.startsWith("/summoner_info")) {
        const user_input = new URL(req.url, `https://${req.headers.host}`).searchParams;
        const summoner_name = user_input.get("summoner_name");
        const tag_id = user_input.get("tag_id");
        console.log(`Summoner Name: ${summoner_name}, Tag ID: ${tag_id}`);

        // error handling for invalid inputs
        if (summoner_name == null || summoner_name === "" || tag_id == null || tag_id === "") {
            notFound(res);
            return;
        }
        // encrypted lookup index
        const state = crypto.randomBytes(20).toString("hex");
        summoner_info_arr.push({ summoner_name, tag_id, state });

        // first call to riot api to retrieve puuid
        getSummonerPuuid(state, res);

    }
    // else if (req.url.startsWith("/redirect_page")) {
    //     // after auth from google drive api, redirect to temp html to replace # to ?
    //     const redirect_html_path = path.join(__dirname, "html", 'redirect.html');
    //     fs.createReadStream(redirect_html_path).pipe(res);

    // } 
    else if (req.url.startsWith("/receive_code")) {
        // after replacing, redirect back to server to get access info
        const params = new URL(req.url, `https://${req.headers.host}`).searchParams;

        const state = params.get('state');
        const code = params.get('code');

        send_access_token_request(code, state, res);

    } else {
        notFound(res);
    }
}


function send_access_token_request(code, state, res) {
    console.log("sending access token request");
    const token_endpoint = "https://accounts.google.com/o/oauth2/token";
    const post_data = querystring.stringify({ client_id, client_secret, code, grant_type, redirect_uri });
    let options = {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        }
    }

    // const token_request_time = new Date();

    https.request(
        token_endpoint,
        options,
        (token_stream) => processStream(token_stream, receiveToken, state, token_request_time, res)
    ).end(post_data);
}

// function refresh_token_request(state, refresh_token, res) {
//     console.log("sending refresh access token request");
//     const refresh_enpoint = "https://accounts.google.com/o/oauth2/token";
//     const post_data = querystring.stringify({
//         client_id,
//         client_secret,
//         refresh_token: refresh_token,
//         grant_type: 'refresh_token',
//         redirect_uri
//     });

//     let options = {
//         method: "POST",
//         headers: {
//             "Content-Type": "application/x-www-form-urlencoded"
//         }
//     }

//     const token_request_time = new Date();

//     https.request(
//         refresh_enpoint,
//         options,
//         (refresh_stream) => processStream(refresh_stream, receiveToken, state, token_request_time, res)
//     ).end(post_data);
// }

function receiveToken(token_data, state, token_request_time, res) {
    console.log("new access token received!");
    const token_object = JSON.parse(token_data);
    console.log("token object: ", token_object);

    // create_token_cache(token_object, token_request_time, state);

    uploadToDrive(state, token_object, res);
}


// function create_token_cache(token_object, token_request_time) {
//     console.log("creating a token cache...");
//     token_object.expiration = new Date(token_request_time.getTime() + (token_object.expires_in * 1000));
//     console.log("current date: ", new Date().toString());
//     console.log("token expiration date: ", token_object.expiration.toString());
//     fs.writeFile(path.join(__dirname, 'cache', 'authentication_res.json'), JSON.stringify(token_object), () => { console.log("Access Token Cached") });

// }

// get summoner puuid, then call get_summoner_last_match_id synchronously

function getSummonerPuuid(state, res) {
    // debugging purpose
    console.log("getting summoner puuid...");

    // lookup info using state
    let summoner_state = summoner_info_arr.find(summoner_state => summoner_state.state === state);

    // error checking for state
    if (state === null || state === "" || summoner_state === null || summoner_state === "") {
        console.log("error")
        console.log(`state: ${state}, summoner_state: ${summoner_state}`)
        notFound(res);
        return;
    }

    const riot_endpoint = `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${summoner_state.summoner_name}/${summoner_state.tag_id}`;

    console.log("sending puuid request to riot api...")

    https.request(
        riot_endpoint,
        riot_options,
        (summoner_stream) => processStream(summoner_stream, serveResults, res)
    ).end();

    function serveResults(summoner_data, res) {
        console.log("puuid retrieved!");

        let summoner_object = JSON.parse(summoner_data);

        // error checking for empty entry
        if (summoner_object.puuid != null) {
            let summoner_puuid = summoner_object.puuid;
            // console.log(summoner_puuid);
            puuid_arr.push({ summoner_puuid, state });

            getSummonerLastMatchId(state, res);
        } else {
            notFound(res);
        }
    }
}

// get last match id and then call get_match_info synchronously
function getSummonerLastMatchId(state, res) {
    // debugging purpose
    console.log("getting summoner's last match id...");

    //lookup for correct puuid
    let puuid_state = puuid_arr.find(puuid_state => puuid_state.state === state);
    console.log(`state: ${state}, puuid_state: ${puuid_state}`)
    if (state === undefined || puuid_state === undefined) {
        console.log("error")
        notFound(res);
        return;
    }
    // console.log(puuid_state)
    const match_endpoint = `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid_state.summoner_puuid}/ids?type=ranked&start=0&count=1`;

    console.log("sending match id request to riot api...")

    https.request(
        match_endpoint,
        riot_options,
        (matchID_stream) => processStream(matchID_stream, serveResults, res)
    ).end();

    function serveResults(matchID_data, res) {
        console.log("match id retrieved!");

        let match_object = JSON.parse(matchID_data);
        // console.log(match_object)
        if (Array.isArray(match_object)) {
            let match_id = match_object[0];

            if (match_id != null) {
                match_id_arr.push({ match_id, state });
                getMatchInfo(state, res);
            } else {
                console.log("error")
                notFound(res);
            }
        } else {
            console.log("error")
            notFound(res);
        }
    }
}

// get match info and store them into lists
function getMatchInfo(state, res) {
    // debugging purpose
    console.log("getting the match information...");

    //lookup for correct match id
    let match_id_state = match_id_arr.find(match_id_state => match_id_state.state === state);

    // error checking
    if (state === null || state === "" || match_id_state === null || match_id_state === "") {
        notFound(res);
        return;
    }

    const match_info_endpoint = `https://americas.api.riotgames.com/lol/match/v5/matches/${match_id_state.match_id}`;

    console.log("sending match object request to riot api...")

    https.request(
        match_info_endpoint,
        riot_options,
        (match_stream) => processStream(match_stream, serveResults, res)
    ).end();

    function serveResults(match_info_data, res) {
        console.log("match info retrieved!");

        let match_info_object = JSON.parse(match_info_data);

        if (match_info_object == null) {
            notFound(res);
        }

        let match_obj = [];
        let win_team = [];
        let lose_team = [];

        for (let i = 0; i < 10; i++) {
            // summoner name, champion name, level
            let player_name = `${match_info_object.info.participants[i].summonerName}  ${match_info_object.info.participants[i].championName}  Lv:${match_info_object.info.participants[i].champLevel} `;
            // kda: k/d/a
            let player_kda = `${match_info_object.info.participants[i].kills}/${match_info_object.info.participants[i].deaths}/${match_info_object.info.participants[i].assists}`;

            let player_info = [player_name, player_kda];

            if (match_info_object.info.participants[i].win === false) {
                lose_team.push(player_info);
            } else {
                win_team.push(player_info);
            }
        }

        match_obj.push(win_team);
        match_obj.push(lose_team);

        match_info_arr.push({ match_obj, state })


        // write data into a text file 
        writeFile(state);
        redirectToDriveAuth(state, res);
        // checkCache(state, res);
    }
}

// function checkCache(state, res) {
//     const cache_file = path.join(__dirname, 'cache', 'authentication_res.json');

//     if (fs.existsSync(cache_file)) {
//         cache_token_object = require(cache_file);
//         if (new Date(cache_token_object.expiration) > Date.now()) {
//             console.log("The cache exists and is valid and is not expired");
//             uploadToDrive(state, cache_token_object, res);
//         } else {
//             console.log("The cache exists but is expired");
//             refresh_token_request(state, cache_token_object.refresh_token, res);
//         }

//     } else {
//         console.log("There is no cache for access token, generating new one...")
//         redirectToDriveAuth(state, res);
//     }
// }

// helper function that returns 404 not found

function notFound(res) {
    console.log("NOT FOUND!")
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(`<h1>404 Not Found</h1>`);
}

// general helper function for reading data
function processStream(stream, callback, ...args) {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => callback(body, ...args));
}

// writing data into a text file, will be used to upload to google drive
// the format of the txt file should be:
//VICTORY TEAM
// summoner name  champion name  kda
// ...
//DEFEAT TEAM
// summoner name  champion name  kda
// ...
function writeFile(state) {
    console.log("writing data into file...");

    // verify the state
    let match_info_state = match_info_arr.find(match_info_state => match_info_state.state === state);
    if (state === undefined || match_info_state === undefined) {
        notFound(res);
        return;
    }
    console.log(state);

    const file_path = path.join(__dirname, 'analysis', `${state}&analysis.txt`);

    data = match_info_state.match_obj;

    //column titles first 
    const labels = "Summoner Name   Champion Name   KDA\n";
    fs.appendFileSync(file_path, labels);

    for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < data[i].length; j++) {
            for (let k = 0; k < data[i][j].length; k++) {
                // console.log(data[i][j][k]);

                if ((i === 0 || i === 1) && j === 0 && k === 0) {
                    let label = "";
                    if (i === 0) {
                        label = "VICTORY TEAM\n";
                    } else {
                        label = "DEFEAT TEAM\n";
                    }
                    fs.appendFileSync(file_path, label);
                }

                let append_data = data[i][j][k];
                if (k === data[i][j].length - 1) {
                    append_data += "\n";
                }
                fs.appendFileSync(file_path, append_data, (err) => {
                        if (err) throw err;

                        if (i === data.length - 1 && j === data[i].length - 1 && k === data[i][j].length - 1) {
                            console.log("The file has been successfully written!");
                            // uploadFile(file);
                        }
                    })
                    // console.log(`i: ${i}, j: ${j}, k: ${k}`);
                    // console.log(`i_max: ${data.length-1}, j_max: ${data[i].length-1}, k_max: ${data[i][j].length-1}`)
            }
        }
    }
}

// redirect users to authorization, then to localhost 3000 receive code when finished

function redirectToDriveAuth(state, res) {
    console.log("redirecting to google drive for authentication...")

    const authorization_endpoint = "https://accounts.google.com/o/oauth2/v2/auth";

    let uri = querystring.stringify({ client_id, redirect_uri, response_type, scope, access_type, state });
    res.writeHead(302, { Location: `${authorization_endpoint}?${uri}` }).end();
}


function uploadToDrive(state, token_object, res) {
    console.log("uploading file to google drive...")

    const upload_endpoint = `https://www.googleapis.com/upload/drive/v3/files?uploadType=media`; //upload endpoint

    const file_path = path.join(__dirname, 'analysis', `${state}&analysis.txt`);

    // console.log(file_path)

    if (!fs.existsSync(file_path)) {
        console.error('File not found:', file_path);
        notFound(res);
        // Handle file not found error (e.g., send an error response to the user)
        return;
    }

    const file_content = fs.readFileSync(file_path); // Read the file into a Buffer
    const file_size = file_content.length;
    // const file_type = mime.lookup(file_path);
    const file_type = "text/plain";

    // const metadata = {
    //     name: "LOL-Analysis.txt",
    //     mimeType: file_type
    // };

    const options = {
        method: 'POST',
        headers: {
            'Authorization': `${token_object.token_type} ${token_object.access_token}`,
            'Content-Type': file_type,
            'Content-Length': file_size
        }
    };

    const req = https.request(upload_endpoint, options, (response) => {
        let response_data = '';

        response.on('data', (chunk) => {
            response_data += chunk;
        });

        response.on('end', () => {
            if (response.statusCode === 200) { // Check for success
                console.log('File uploaded successfully:', JSON.parse(response_data));

                try {
                    fs.unlinkSync(file_path);
                    console.log('File deleted successfully!');
                } catch (err) {
                    console.error('Error deleting file:', err);
                }

                redirectToDriveUI(res); // Redirect only on success
            } else {
                console.error('Upload failed:', response.statusCode, response_data);
                // Handle the error (e.g., send an error response to the user)
            }
        });
    });

    req.on('error', (error) => {
        console.error('Error uploading file:', error);
        // Handle the error (e.g., show an error message to the user)
    });

    req.write(file_content);
    req.end();
}

// function uploadToDrive(state, accessToken, tokenType, res) {
//     const filePath = `./Final-Project/analysis/${state}&analysis.txt`;
//     const fileName = "LOL-Match_Analysis.txt";
//     const fileDescription = "Summary of LoL match";

//     const initiateUpload = () => {
//         const options = {
//             hostname: 'www.googleapis.com',
//             path: '/upload/drive/v3/files?uploadType=resumable&fields=id',
//             method: 'POST',
//             headers: {
//                 'Authorization': `${tokenType} ${accessToken}`,
//                 'Content-Type': 'application/json; charset=UTF-8',
//                 'X-Upload-Content-Type': 'text/plain',
//                 'X-Upload-Content-Length': fs.statSync(filePath).size,
//             },
//         };

//         const req = https.request(options, (res) => {
//             handleInitiateResponse(res);
//         });

//         req.on('error', (error) => {
//             console.error('Error initiating upload:', error);
//             res.status(500).send('Internal Server Error');
//         });

//         req.end(JSON.stringify({ name: fileName }));
//     };

//     const handleInitiateResponse = (res) => {
//         if (res.statusCode === 200) {
//             const location = res.headers.location;
//             if (location) {
//                 uploadFile(location);
//             } else {
//                 console.error('Missing Location header in initiate response');
//                 res.status(500).send('Internal Server Error');
//             }
//         } else {
//             console.error('Failed to initiate upload. Status code:', res.statusCode);
//             res.status(500).send('Internal Server Error');
//         }
//     };

//     const uploadFile = (location) => {
//         const fileStream = fs.createReadStream(filePath);
//         const uploadUrl = new URL(location);

//         const options = {
//             hostname: uploadUrl.hostname,
//             path: uploadUrl.pathname + uploadUrl.search,
//             method: 'PUT', // Or 'POST' if you want to handle chunks manually
//             headers: {
//                 'Content-Length': fs.statSync(filePath).size,
//             },
//         };

//         const req = https.request(options, (res) => {
//             handleUploadResponse(res, location);
//         });

//         fileStream.on('error', (error) => {
//             console.error('Error reading file:', error);
//             req.abort();
//             res.status(500).send('Internal Server Error');
//         });

//         fileStream.pipe(req);
//     };

//     const handleUploadResponse = (res, location) => {
//         if (res.statusCode === 200 || res.statusCode === 201) {
//             updateMetadata(location);
//         } else if (res.statusCode === 308) {
//             // Resume Incomplete (chunk uploaded successfully)
//             console.log('Chunk uploaded, continuing...');
//         } else {
//             console.error('Failed to upload file. Status code:', res.statusCode);
//             res.status(500).send('Internal Server Error');
//         }
//     };

//     const updateMetadata = (location) => {
//         console.log(location)
//         const url = new URL(location);
//         console.log("url location, ", url)
//         const url_param = url.searchParams; // Extract fileId from URL
//         const fileId = url_param.get("session_crd");
//         console.log(fileId, "file id");

//         const options = {
//             hostname: 'www.googleapis.com',
//             path: `/drive/v3/files/${fileId}?fields=webContentLink`, // Request webContentLink
//             method: 'PATCH',
//             headers: {
//                 'Authorization': `${tokenType} ${accessToken}`,
//                 'Content-Type': 'application/json',
//             },
//         };

//         const req = https.request(options, (metadataRes) => {
//             console.log(metadataRes)
//             if (metadataRes.statusCode === 200) {
//                 let data = '';
//                 metadataRes.on('data', (chunk) => data += chunk);
//                 metadataRes.on('end', () => {
//                     const responseJson = JSON.parse(data);

//                     // Explicitly check for webContentLink
//                     if (responseJson.webContentLink) {
//                         const webContentLink = responseJson.webContentLink;

//                         // Redirect to Drive
//                         redirectToDriveUI(res);
//                     } else {
//                         console.error('Failed to update metadata: webContentLink not found');
//                         // res.status(500).send('Internal Server Error');
//                     }
//                 });
//             } else {
//                 console.error('Failed to update metadata. Status code:', metadataRes.statusCode);
//                 // res.status(500).send('Internal Server Error');
//             }
//         });

//         req.on('error', (error) => {
//             console.error('Error updating metadata:', error);
//             res.status(500).send('Internal Server Error');
//         });

//         req.end(JSON.stringify({ description: fileDescription }));
//     };

//     initiateUpload();
// }

function redirectToDriveUI(res) {
    console.log("redirecting user to google drive...")
    const redirectUrl = `https://drive.google.com/drive/u/0/my-drive`; // You can customize this URL
    res.writeHead(302, { Location: redirectUrl });
    res.end();
}