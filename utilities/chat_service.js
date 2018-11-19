//Get the connection to Heroku Database
let db = require('./utils.js').db;

// firebase module
let fcm_functions = require('../utilities/utils').fcm_functions;

//Error codes returned on failure
const error = require('./error_codes.js');


function addConversation(token, theirEmail) {
    if(!(token && theirEmail)) {
        return _handleMissingInputError();
    }

    let myMemberId;
    let theirMemberId;
    let isNewConversation;
    let result = new Object();
    
    return _getUserOnToken(token)
        .then(user => {
            myMemberId = user.memberid;
            // check if the other user has a connection to the caller
            return _getConnectionId(myMemberId, theirEmail);
        }).then(connection => {
            theirMemberId = connection.memberid;
            // check if the two users have an active chat
            return _getChatId(myMemberId, theirMemberId)
        }).then(chat => {
            if (chat) {
                result.chatId = chat.chatid;
                return _getAllMessages(chat.chatid);
            } else {
                isNewConversation = true;
                return _createNewChat(myMemberId, theirMemberId);
            }
        }).then(data => {
            if (isNewConversation) {
                result.chatId = data.chatid;
                result.messages = new Array();
            } else {
                result.messages = data;
            }
            
            return result;
        })
}

/**
 * Get all messages for the given chatId.
 * @param {*} token 
 * @param {*} chatId 
 */
function getAllMessages(token, chatId) {
    // args must not be null
    if (!(token && chatId)) {
        return _handleMissingInputError();
    }

    let result = { chatId };

    return _getUserOnToken(token)
        .then(() => _getAllMessages(chatId))
        .then(messages => {
            result.messages = messages;
            return result;
        })
}       

function sendMessage(token, chatId, message) {
    if (!(chatId && message && token)) {
        // token not required yet because we are not passing it from app
        return _handleMissingInputError();
    }

    
    // get user on email because that's all we have
    return _getUserOnToken(token)
        .then(data => {
            user = data;
            return _addMessage(chatId, message, user.memberid);
        }).then(() => _sendChatMessage(user.username, chatId, message));
}

// Helper functions for synchronous repeated work

/**
 * returns a user object without any sensitive information
 */ 
function _stripUser(theUser) {
    return {
        first: theUser.firstname,
        last: theUser.lastname,
        username: theUser.username,
        email: theUser.email
    }
}


// Database queries
function _getUserOnToken(token) {
    return db.one('SELECT * FROM Members NATURAL JOIN FCM_Token WHERE token=$1', [token])
        .catch(err => {
            if (err.code == 0) {
                _handleSessionError(error.INVALID_TOKEN);
            } else {
                _handleDbError(err);
            }
        });            
}

function _getAllMessages(chatId) {
    let query = `SELECT Members.Email, Members.Username, Messages.Message, 
    to_char(Messages.Timestamp AT TIME ZONE 'PST', 'YYYY-MM-DD HH24:MI:SS.US' ) AS Timestamp
    FROM Messages
    INNER JOIN Members ON Messages.MemberId=Members.MemberId
    WHERE ChatId=$1 
    ORDER BY Timestamp DESC`

    return db.any(query, [chatId])
        .catch(err => _handleDbError(err));
}

function _getConnectionId(myId, theirEmail) {
    let query = `SELECT DISTINCT AllConnections.memberid FROM
                 (
                    (SELECT * FROM Members INNER JOIN Contacts ON Members.memberid=Contacts.memberid_b WHERE memberid_a=$1 AND verified=1)
                    UNION
                    (SELECT * FROM Members INNER JOIN Contacts ON Members.memberid=Contacts.memberid_a WHERE memberid_b=$1 AND verified=1)
                 ) AS AllConnections
                 WHERE AllConnections.email=$2`

    return db.one(query, [myId, theirEmail])
        .catch(err => {
            if (err.code == 0) {
                _handleSessionError(error.INVALID_CONNECTION);
            } else {
                _handleDbError(err);
            }
        });
}

function _getChatId(myId, theirId) {
    let query = `select TblA.chatid FROM chatmembers AS TblA INNER JOIN chatmembers AS TblB ON TblA.chatid=TblB.chatid
                 WHERE TblA.memberid=$1 AND TblB.memberid=$2`

    // this query only works for "private chat" where exactly one chat includes both users
    return db.oneOrNone(query, [myId, theirId])
        .catch(err => _handleDbError(err));
}

function _createNewChat(myId, theirId) {
    let newChatInsert = `INSERT INTO Chats(name) VALUES ('Private Chat') RETURNING chatid`
    let membersInsert = `INSERT INTO ChatMembers(chatid, memberid) VALUES ($1, $2),($1, $3)`

    let result;

    return db.task(t => {
        return t.one(newChatInsert)
            .then(data => {
                result = data;
                return t.none(membersInsert, [data.chatid, myId, theirId]);
            }).then(() => {
                return result;
            }).catch(err => _handleDbError(err));
    });
}


function _addMessage(chatId, message, memberId) {
    let insert = 'INSERT INTO Messages(ChatId, Message, MemberId) VALUES($1, $2, $3)';
                        
    return db.none(insert, [chatId, message, memberId])
        .catch(err => _handleDbError(err));
}

function _sendGlobalMessage(senderEmail, message) {
    return db.manyOrNone('SELECT * FROM FCM_Token')
        .then(rows => {
            rows.forEach(element => {
                fcm_functions.sendToIndividual(element['token'], message, senderEmail);
            });
        })
        .catch(err => _handleDbError(err));
}

function _sendChatMessage(senderName, chatId, message) {
    return db.manyOrNone('SELECT token FROM FCM_Token NATURAL JOIN ChatMembers WHERE chatid=$1', [chatId])
        .then(rows => {
            rows.forEach(element => {
                fcm_functions.sendToIndividual(element['token'], message, senderName, chatId);
            });
        })
        .catch(err => _handleDbError(err));
}

// take this out after token passing is implemented in app
function _getUserOnEmailNoPassword(email) {
    return db.oneOrNone('SELECT * FROM Members WHERE Email=$1', [email])
        .catch(err => _handleDbError(err));
}

// Error handlers
function _handleDbError(err) {
    // print detailed error message to console
    console.dir({error: error.DATABASE, message: err});
    // must throw error to prevent return to caller
    throw(error.DATABASE);
}

function _handleSessionError(err) {
    // print error message to console
    console.dir({error: err});
    // must throw error to prevent return to caller
    throw(err);
}

function _handleMissingInputError() {
    // simple handling of null parameters rejects promise execution
    return Promise.reject(error.MISSING_PARAMETERS);
}

// any function included in exports will be public
module.exports = {
    getAllMessages, sendMessage, addConversation
}