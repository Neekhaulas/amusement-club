const Discord = require("discord.js");
const dbManager = require("./modules/dbmanager.js");
const utils = require("./modules/localutils.js");
const logger = require('./modules/log.js');
const settings = require('./settings/general.json');
var bot;

//https://discordapp.com/oauth2/authorize?client_id=340988108222758934&scope=bot&permissions=125952

dbManager.connect();
_init();

function _init() {
    bot = new Discord.Client();

    bot.on("ready", () => {
        console.log("Discord Bot Connected");
        bot.user.setGame("->help");
        console.log("Discord Bot Ready");
    });

    bot.on("disconnected", () => {
        console.log("Discord Bot Disconnected");
    });

    bot.on("message", (message) => {
        if(message.author.bot) 
            return false;

        log(message);
        getCommand(message, (res, obj) => {
            if(!res && !obj) 
                return false;
                
            message.channel.send(res, obj);
        });
    });

    console.log("Trying to log in ");
    bot.login(settings.token).catch((reason) => {
        console.log(reason);
    });
}

function _stop() {
    logger.message("Discord Bot Shutting down");
    return bot.destroy();
}

function log(message) {
    var msg = '';
    try {
		msg = message.guild.name + " : " + message.channel.name + " : " + message.author.username + " : " + message.content;
	} catch(e) {
		msg = "PW : " + message.author.username + " : " + message.content;
	}
    logger.message(msg);
}

function getCommand(m, callback) {
    dbManager.addXP(m.author, m.content.length / 10);

    if(m.content.startsWith('->')) {
        let cnt = m.content.substring(2).split(' ');
        let sb = cnt.shift();
        let cd = cnt.join(' ').trim();

        switch(sb) {
            case 'help': 
                callback(showHelp(m));
                return;
            case 'cl': 
            case 'claim': 
                dbManager.claim(m.author, (text, img) => {
                    callback(text, {file: img });
                });
                return;
            case 'summon':
            case 'sum': 
                if(cd.length < 4) 
                    callback("Please, specify card name");
                else {
                    dbManager.summon(m.author, cd, (text, img) => {
                        callback(text, {file: img });
                    });
                }
                return;
            case 'bal': 
            case 'balance': 
                dbManager.getXP(m.author, (bal) =>{
                    let msg = "**" + m.author.username + "** has **" + Math.floor(bal) + "** 🍅 Tomatoes!";
                    if(bal > 100) msg += " Can claim " + Math.floor(bal/100) + " cards! Use ->claim";
                    callback(msg);
                });
                return;
            case 'give':
                let usr = getUserID(cnt.shift());
                let cdname = cnt.join(' ').trim();
                if(usr){
                    dbManager.transfer(m.author, usr, cdname, (text) =>{
                        callback(text);
                    });
                }
                return;
            case 'cards':
                let targetUsr = getUserID(cnt.shift());
                let author = targetUsr? targetUsr : m.author.id;
                dbManager.getCards(author, (text) =>{
                    callback(text);
                });
                return;
            case 'sell':
                dbManager.sell(m.author, cd, (text) =>{
                    callback(text);
                });
                return;
            case 'er': 
                callback("1 🍅 Tomato is now 10 Mekos");
                return;
            case 'award': 
                if(isAdmin(m.author.id)) {
                    let tusr = getUserID(cnt.shift());
                    let tom = parseInt(cnt);
                    if(tusr && tom){
                        dbManager.award(tusr, tom, (text) =>{
                            callback(text);
                        });
                    } else {
                        callback("Wrong arguments");
                    }
                } else {
                    callback(m.author.username + ", 'award' is admin-only command");
                }
                return;
            case 'kill': 
                if(isAdmin(m.author.id)) {
                    callback("Shutting down now");
                    setTimeout(() => { _stop(); }, 2000); 
                }
                return;
        }
    } 

    callback(undefined);
}

function isAdmin(sender) {
    return settings.admins.includes(sender);
}

function showHelp(message) {
    let embed = {
		author: {
			name: "⭐ Amusement Club ⭐ Card Game \n",
		},
        color: utils.HEXToVBColor(settings.botcolor),
		fields: [{
			name:"->claim",
			value:"Claim a new card (costs 100 🍅 Tomatoes)",
			inline: false
        }, {
			name: "->sum [name]",
			value: "Summons a card with name (in case you have it)",
			inline: false
		}, {
			name: "->bal",
			value: "Shows your current 🍅 Tomato balance",
			inline: false
        }, {
			name: "->give [user] [card]",
			value: "Transfers card to user",
			inline: false
        }, {
			name: "->cards [user (optional)]",
			value: "Shows your cards, or some other [user]",
			inline: false
        }, {
			name: "->sell [card]",
			value: "Sells a card. ⭐=50🍅 | ⭐⭐=75🍅 | ⭐⭐⭐=100🍅",
			inline: false
        },
        /*{
			name:"->er",
			value:"Shows Tomato:Mekos exchange rate",
			inline: false
        }, {
			name:"->mekos",
			value:"Changes all Mekos to Tomatoes (one-time operation)",
			inline: false
        }, */
        {
			name: "Bot source code",
			value: "https://github.com/NoxCaos/amusement-club/",
			inline: false
		}]
    }
    message.author.send("", { embed });
    return message.author.username + ", I've sent you a DM";
}

function getUserID(inp) {
    try{
        return inp.slice(0, -1).split('@')[1].replace('!', '');
    } catch(e) {
        return null;
    }
}