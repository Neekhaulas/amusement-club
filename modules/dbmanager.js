module.exports = {
    connect, disconnect, claim, addXP, getXP, doesUserHave,
    getCards, summon, transfer, sell, award, getUserName,
    pay, daily, getQuests, getBestCardSorted, getUserCards,
    leaderboard, difference, dynamicSort, countCardLevels, getCardValue,
    getCardFile, getDefaultChannel, isAdmin, needsCards, getCardURL,
    removeCardFromUser, addCardToUser, eval, whohas, block, fav, track
}

var MongoClient = require('mongodb').MongoClient;
var mongodb, client, userCount;
var cooldownList = [];
var modifyingList = [];

const fs = require('fs');
const assert = require('assert');
const logger = require('./log.js');
const quest = require('./quest.js');
const heroes = require('./heroes.js');
const _ = require("lodash");
const settings = require('../settings/general.json');
const guilds = require('../settings/servers.json');
const promotions = require('../settings/promotions.json');
const dailymessage = require('../help/promomessage.json');
const utils = require('./localutils.js');
const listing = require('./reactions.js');
const cardmanager = require('./cardmanager.js');
const forge = require('./forge.js');
const inv = require('./inventory.js');
const stats = require('./stats.js');
const invite = require('./invite.js');
const helpMod = require('./help.js');
const vote = require('./vote.js');
const transactions = require('./transactions.js');
const ratioInc = require('./ratioincrease.json');
const lev = require('js-levenshtein');
const sellManager = require('./sell.js');
const auctions = require('./auctions.js');
const collections = require('./collections.js');

function disconnect() {
    isConnected = false;
    mongodb.close();
}

function connect(bot, callback) {
    client = bot;
    MongoClient.connect(settings.database, function(err, db) {
        assert.equal(null, err);
        logger.message("[DB Manager] Connected correctly to database");

        mongodb = db;
        quest.connect(db);
        heroes.connect(db);
        forge.connect(db);
        inv.connect(db);
        stats.connect(db);
        transactions.connect(db);
        //cardmanager.updateCards(db);
        invite.connect(db, client);
        helpMod.connect(db, client);
        vote.connect(db, client);
        sellManager.connect(db);
        auctions.connect(db, client);
        collections.connect(db);

        let date = new Date();
        let deletDate = new Date(date.setDate(date.getDate() - 5));
        db.collection('transactions').remove({time: {$lt: deletDate}}).then(res => {
            console.log("Removed old transactions: " + res.result.n);
        });

        db.collection('auctions').remove({date: {$lt: deletDate}}).then(res => {
            console.log("Removed old auctions: " + res.result.n);
        });

        db.collection('users').count({'cards.1': {$exists: true}}).then(uc => {
            userCount = uc;
        });

        if(callback) callback();   
    });
}

function claim(user, guildID, arg, callback) {
    let ucollection = mongodb.collection('users');
    ucollection.findOne({ discord_id: user.id }).then((dbUser) => {
        if(!dbUser) {
            ucollection.insert( { 
                discord_id: user.id,
                username: user.username,
                cards: [],
                exp: 2000,
                gets: 50,
                sends: 50
            }).then(() => {
                claim(user, guildID, arg, callback);
            });
            return;
        }

        // if(_.sample([0,1,2]) === 0)
        //     return getRandomJoke(dbUser, callback);

        let any = false;
        let promo = false;
        let amount = 1;
        try { 
            arg.forEach(e => {
                if(utils.isInt(e)) amount = parseInt(e);
                else {
                    any = e == 'any';
                    promo = e == 'promo';
                }
            }, this);
        } catch(exc){}

        if(!dbUser.dailystats) dbUser.dailystats = {summon:0, send: 0, claim: 0, get: 0, quests: 0};

        amount = Math.min(Math.max(parseInt(amount), 1), 20 - dbUser.dailystats.claim);

        if(promo) {
            claimPromotion(user, dbUser, amount, callback);
            return;
        }

        let claimCost = getClaimsCost(dbUser, amount);
        let nextClaim = 50 * (dbUser.dailystats.claim + amount + 1);
        if(dbUser.exp < claimCost) {
            callback("**" + user.username + "**, you don't have enough 🍅 "
                + ((amount == 1)? "to claim a card" : "to claim **" + amount + "** cards")
                + "\nYou need at least **" + claimCost + "**, but you have **" + Math.floor(dbUser.exp) + "**");
            return;
        }

        if (amount === 0) {
            callback("**" + user.username + "**, you reached a limit of your daily claim. \n"
                + "It will be reset next time you successfully run `->daily`");
            return;
        }

        let collection = mongodb.collection('cards');
        let guild = guilds.filter(g => g.guild_id == guildID)[0];
        let query = [ 
            { $match: { } },
            { $sample: { size: amount } } 
        ]

        if(guild && !any) {
            query[0].$match.collection = guild.collection;
            query[0].$match.craft = {$in: [null, false]};
        }

        collection.aggregate([ 
            { $match: { level : 3 } },
            { $sample: { size: 1 } } 
        ]).toArray((err, extra) => {
            collection.aggregate(query).toArray((err, res) => {
                let phrase = "**" + user.username + "**, you got";
                nextClaim = heroes.getHeroEffect(dbUser, 'claim_akari', nextClaim);

                if(forge.getCardEffect(dbUser, 'claim', false)[0]) {
                    res.shift();
                    res.push(extra[0]);
                } 

                res.sort(dynamicSort('-level'));

                if(amount == 1) {
                    let names = [];
                    phrase += " [" + utils.getFullCard(res[0]) + "](" + getCardURL(res[0]) + ")\n";
                    if(res[0].craft) phrase += "This is a **craft card**. Find pair and `->forge` special card of them!\n";
                    if(dbUser.cards && dbUser.cards.filter(c => utils.cardsMatch(c, res[0])).length > 0)
                        phrase += "*you already have this card*\n";
                } else {
                    phrase += " (new cards are bold):\n"
                    for (var i = 0; i < res.length; i++) {
                        if(dbUser.cards 
                            && dbUser.cards.filter(c => utils.cardsMatch(c, res[i])).length > 0)
                            phrase += (i + 1) + ". " + utils.getFullCard(res[i]);
                        else phrase += (i + 1) + ". **" + utils.getFullCard(res[i]) + "**";
                        phrase += "\n";
                    }
                    phrase += "\nUse `->sum [card name]` to summon a card\n";
                }

                //if(claimCost >= 500) phrase += "*You are claiming for extremely high price*\n";            
                phrase += "Your next claim will cost **" + nextClaim + "**🍅";

                let incr = {exp: -claimCost};
                if(promotions.current > -1) {
                    let prm = promotions.list[promotions.current];
                    let addedpromo = Math.floor(claimCost / 2);
                    incr = {exp: -claimCost, promoexp: addedpromo};
                    phrase += "\n You got additional **" + addedpromo + "** " + prm.currency;
                }

                if(!dbUser.cards) dbUser.cards = [];
                res.map(r => dbUser.cards = addCardToUser(dbUser.cards, r));

                dbUser.dailystats.claim += amount;
                heroes.addXP(dbUser, .5 * amount);
                ucollection.update(
                    { discord_id: user.id },
                    {
                        $set: {cards: dbUser.cards, dailystats: dbUser.dailystats},
                        $inc: incr
                    }
                ).then(() => {
                    // let emb = utils.formatInfo(null, null, phrase);
                    // if(amount == 1) emb.image = { "url": getCardURL(res[0]) };
                    // callback(emb);
                    callback(utils.formatImage(null, null, phrase, getCardURL(res[0])));
                    quest.checkClaim(dbUser, callback);
                }).catch(e => console.log(e));
            });
        });
    });
}

function claimPromotion(user, dbUser, amount, callback) {
    let ucollection = mongodb.collection('users');

    let claimCost = getPromoClaimsCost(dbUser, amount);
    if(promotions.current == -1) {
        callback("**" + user.username + "**, there are no promotional cards available now");
        return;
    }

    let promo = promotions.list[promotions.current];
    if(!dbUser.promoexp){
        callback("**" + user.username + "**, you have to earn some " + promo.currency + " first.\n"
            + "To earn them claim ordinary cards");
        return;
    }
    
    if(dbUser.promoexp < claimCost) {
        callback("**" + user.username + "**, you don't have enough " + promo.currency + " to claim a card \n" 
            + "You need at least " + claimCost + ", but you have " + Math.floor(dbUser.promoexp));
        return;
    }
    
    let collection = mongodb.collection('promocards');
    let query = [ 
            { $match: { collection: promo.name, level: {$lt: 3} } },
            { $sample: { size: amount } } 
    ];

    collection.aggregate(query).toArray((err, res) => {
        let phrase = "**" + user.username + "**, you got";

        res.sort(dynamicSort('-level'));
        if(amount == 1) {
            phrase += " **" + utils.toTitleCase(res[0].name.replace(/_/g, " ")) + "**\n";
            if(dbUser.cards && dbUser.cards.filter(
                c => c.name == res[0].name && c.collection == res[0].collection).length > 0)
                phrase += "(*you already have this card*)\n";
            //phrase += "Forge this card with other promo cards and get crystals!\n"
        } else {
            phrase += " (new cards are bold):\n"
            for (var i = 0; i < res.length; i++) {
                if(dbUser.cards 
                    && dbUser.cards.filter(c => c.name == res[i].name && c.collection == res[i].collection).length > 0)
                    phrase += (i + 1) + ". " + utils.getFullCard(res[i]);
                else phrase += (i + 1) + ". **" + utils.getFullCard(res[i]) + "**";
                phrase += "\n";
            }
            phrase += "\nUse `->sum [card name]` to summon a card\n";
            //phrase += "Use `->forge [card 1], [card 2], ...` to combine cards into crystals\n";
        }
        phrase += "You have now **" + (dbUser.promoexp - claimCost) + "** " + promo.currency;

        res.map(r => dbUser.cards = addCardToUser(dbUser.cards, r));

        dbUser.dailystats.promoclaim += amount;
        heroes.addXP(dbUser, .2 * amount);
        ucollection.update(
            { discord_id: user.id },
            {
                $set: {cards: dbUser.cards, dailystats: dbUser.dailystats},
                $inc: {promoexp: -claimCost}
            }
        ).then(() => {
            let emb = utils.formatInfo(null, null, phrase);
            if(amount == 1) emb.image = { "url": getCardURL(res[0]) };
            callback(emb);
            //callback(phrase, ((amount == 1)? getCardFile(res[0]) : null));
        }).catch(e => console.log(e));
    });
}

function addXP(user, amount, callback) {
    if(cooldownList.includes(user.id)) return;
    if(amount > 3) amount = 3;

    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: user.id}).then((res) => {
        if(res) {
            amount = heroes.getHeroEffect(res, 'addXP', amount);
            collection.update( 
                { discord_id: user.id},
                {
                    $set: { username: user.username },
                    $inc: {exp: amount}
                },
                { upsert: true }
            );
        } else {
            collection.update( { discord_id: user.id},
                {
                    $set: { 
                        discord_id: user.id,
                        username: user.username,
                        cards: [],
                        exp: 2000,
                        gets: 50,
                        sends: 50
                    },
                }, { upsert: true }
            );
        }
    });
}

function removeFromCooldown(userID) {
    let i = cooldownList.indexOf(userID);
    cooldownList.splice(i, 1);
}

function removeFromModifying(userID) {
    let i = modifyingList.indexOf(userID);
    modifyingList.splice(i, 1);
}

function getXP(user, callback) {
    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: user.id }).then((dbUser) => {
        if(dbUser) {
            if(!dbUser.dailystats) dbUser.dailystats = {summon:0, send: 0, claim: 0, get: 0, quests: 0};

            let bal = dbUser.exp;
            let stars = countCardLevels(dbUser.cards);
            let claimCost = (dbUser.dailystats.claim + 1) * 50;
            claimCost = heroes.getHeroEffect(dbUser, 'claim_akari', claimCost);
            let msg = [];
            msg.push("**" + user.username + "**, you have **" + Math.floor(bal) + "** 🍅 Tomatoes "
                + "and " + stars + " \u2B50 stars!");

            var blockClaim = heroes.getHeroEffect(dbUser, 'claim', dbUser.dailystats.claim >= 30);
            if(blockClaim) {
                msg.push("You can't claim more cards, as you reached your daily claim limit.")
            } else {
                if(bal > claimCost) 
                    msg.push("You can claim " + getClaimsAmount(dbUser, dbUser.dailystats.claim, bal) + " cards today! Use `->claim [amount]`");
                msg.push("Your claim now costs " + claimCost + " 🍅 Tomatoes");
            }
            if(!dbUser.hero && stars >= 50) msg.push("You have enough \u2B50 stars to get a hero! use `->hero list`");

            if(promotions.current > -1 && dbUser.promoexp) {
                let promo = promotions.list[promotions.current];
                msg.push("A special promotion is now going until **" + promo.ends + "**!");
                msg.push("You have **" + dbUser.promoexp + "** " + promo.currency);
                msg.push("Use `->claim promo` to get special limited time cards");
            }
   
            callback(msg.join("\n"));
        } 
    });
}

function getQuests(user, callback) {
    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: user.id }).then((u) => {
        if(u) {
            let res = "";
            if(!u.quests || u.quests.length <= 0) {
                if(u.hero) res += "you don't have any quests. \n"
                    + "New quests will appear after `->daily`";
                else res += "you will start getting quests once you get a hero";
                return callback(utils.formatError(user, null, res));
            } else {
                for(let i=0; i<u.quests.length; i++) {
                    let award = heroes.getHeroEffect(u, 'questReward', u.quests[i].award);
                    res += (i+1).toString() + ". " + u.quests[i].description;
                    res += " [" + award + "`🍅`] \n";
                }
                return callback(utils.formatInfo(null, u.username + ", your quests for today:", res));
            }
        }
    });
}

function getCards(user, args, callback) {
    let query = utils.getRequestFromFilters(args);
    getUserCards(user.id, query).toArray((err, objs) => {
        if(!objs || !objs[0]) 
            return callback(utils.formatError(user, null, "no cards found that match your request"), false);

        let cards = objs[0].cards;
        callback(cards, true);
    });
}

function summon(user, args, callback) {
    if(!args) return callback("**" + user.username + "**, please specify name/collection/level");
    let query = utils.getRequestFromFilters(args);
    getUserCards(user.id, query).toArray((err, objs) => {
        if(!objs[0]) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        let cards = objs[0].cards;
        let dbUser = objs[0]._id;
        let match = query['cards.name']? getBestCardSorted(cards, query['cards.name'])[0] : getRandomCard(cards);
        if(!match) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        let alert = "**" + user.username + "** summons [" 
            + utils.toTitleCase(match.name.replace(/_/g, " ")) + "]("
            + getCardURL(match) + ")\n";

        if(match.animated && match.imgur) {
            callback(alert + "\nhttps://i.imgur.com/" + match.imgur + ".gifv");
        } else {
            callback(utils.formatImage(null, null, alert, getCardURL(match)));
        }

        if(!dbUser.dailystats) dbUser.dailystats = {summon:0, send: 0, claim: 0, get: 0, quests: 0};
        dbUser.dailystats.summon++;

        mongodb.collection('users').update(
            { discord_id: user.id }, {$set: {dailystats: dbUser.dailystats}}
        );
    });
}

//DEPRECATED
async function transfer(from, to, args, guild, callback) {
    return callback(utils.formatError(from, "Deprecated command", 
        "since 1.9.12 sending cards was replaced with selling.\n"
        + "Please use `->sell @user card name`\n"
        + "Learn more by running `->help sell`"));

    let collection = mongodb.collection('users');
    modifyingList.push(from.id);
    try {
        await _transfer(collection, from, to, args, guild, callback);
    } finally {
        removeFromModifying(from.id);
    }
}

//DEPRECATED
async function _transfer(collection, from, to, args, guild, callback) {
    let dbUser = await collection.findOne({ discord_id: from.id });
    if (!dbUser) return;

    if (!dbUser.gets) dbUser.gets = 500;
    if (!dbUser.sends) dbUser.sends = 500;

    if (!dbUser.dailystats) dbUser.dailystats = { summon: 0, send: 0, claim: 0, get: 0 };

    if (args.includes("-ratio")) {
        let ratio = utils.getRatio(dbUser).toFixed(2);
        callback(utils.formatInfo(from,
            null, "Your give/get ratio is **" + ratio + "**\n"
            + (ratio < 2.5 ? "You **can** send cards\n" : "You **can not** send cards\n")
            + (ratio > 0.4 ? "You **can** receive cards\n" : "You **can not** receive cards\n")
            + "Max ratio: **2.5**\nMin ratio: **0.4**\n"
            + "You sent today: **" + dbUser.dailystats.send + "**/25\n"
            + "You got today: **" + dbUser.dailystats.get + "**/25"));
        return;
    }

    if (!args || args.length == 0) return callback("**" + from.username + "**, please specify name/collection/level");

    for (m in args) {
        if (args[m].includes("*"))
            return callback("**" + from.username + "**, you can't transfer crystals");
    }

    if (from.id == to) {
        callback(dbUser.username + ", did you actually think it would work?");
        return;
    }

    if (!to) return;
    
    if (dbUser.dailystats.send > 1 && !utils.canSend(dbUser)) {
        callback(utils.formatError(from,
            "Can't send card!",
            "you can't send more cards. Please, trade fairly and consider **getting** more cards from users. Details: `->help trade`\n"
            + "Your give/get ratio is **" + utils.getRatio(dbUser).toFixed(2) + "**"));
        return;
    }

    let query = utils.getRequestFromFilters(args);
    let objs = await getUserCards(from.id, query).toArray();

    if (!objs[0]) return callback(utils.formatError(from, "Can't find card", "can't find card matching that request"));

    let cards = objs[0].cards;
    let match = query['cards.name'] ? getBestCardSorted(cards, query['cards.name'])[0] : cards[0];

    if (!match) return callback(utils.formatError(from, "Can't find card", "can't find card matching that request"));
    if (match.fav && match.amount == 1) return callback(utils.formatError(from, null, "you can't send favorite card."
        + " To remove from favorites use `->fav remove [card query]`"));

    let name = utils.toTitleCase(match.name.replace(/_/g, " "));
    let hours = 20 - utils.getHoursDifference(match.frozen);
    if (match.amount <= 1 && hours && hours > 0) {
        callback(utils.formatError(dbUser, 
            "Card is frozen",
            "the card '**" + name + "**' is frozen for **" 
            + hours + "** more hours! You can't transfer it"));
        return;
    }

    let u2 = await collection.findOne({ discord_id: to });

    if (!u2) return;

    if (u2.blocklist && u2.blocklist.includes(from.id))
        return callback(utils.formatError(from, "Can't send card", "this user blocked trading with you"));

    if (!utils.canGet(u2)) {
        callback(utils.formatError(from,
            "Can't send card!",
            "user **" + u2.username + "** recieved too many cards. This user has to **send** more cards. Details: `->help trade`"));
        return;
    }

    if (!u2.dailystats) u2.dailystats = { summon: 0, send: 0, claim: 0, get: 0 };
    else if (!u2.dailystats.get) u2.dailystats.get = 0;

    if (u2.dailystats.get > 25) return callback(utils.formatError(from,
        "Can't send card!",
        "user **" + u2.username + "** is out of daily trading limit. This user can't get more cards today"));

    if (modifyingList.indexOf(u2.discord_id) > -1) {
        return callback(utils.formatError(from,
            "Can't send card!",
            "user **" + u2.username + "** can't accept cards right now, try to send again."));
    }

    match.fav = false;
    dbUser.cards = removeCardFromUser(dbUser.cards, match);
    u2.cards = addCardToUser(u2.cards, match);
    dbUser.dailystats.send++;
    u2.dailystats.get++;

    var fromExp = dbUser.exp;
    fromExp = heroes.getHeroEffect(dbUser, 'send', fromExp, match.level);
    if (fromExp > dbUser.exp)
        callback("**Akari** grants **" + Math.round(fromExp - dbUser.exp)
            + "**🍅 to **" + dbUser.username
            + "** for sending a card!");

    if (dbUser.dailystats.send === 25)
        callback(utils.formatWarning(from, null, "your **next** transfer will cost **100** Tomatoes"));
    else if (dbUser.dailystats.send > 25) {
        let fee = (dbUser.dailystats.send - 25) * 100;

        if (fee > dbUser.exp) return callback(utils.formatError(dbUser,
            "Can't send card!",
            "you don't have enough **Tomatoes** to pay your trading fee!"));

        callback(utils.formatWarning(from, null, "you paid **" + fee + "** Tomatoes fee, because you are over your daily trade limit"));
        fromExp -= fee;
    }

    heroes.addXP(dbUser, .2);
    let price = await new Promise(resolve => {
        getCardValue(match, price => {
            resolve(price);
        });
    });

    let ratioIncrease = (price === Infinity ? 0 : price / 100);
    if (quest.preCheckSend(dbUser, match.level)) ratioIncrease = 0;
    let newSends = objs[0]._id.sends + ratioIncrease;
    let newGets = objs[0]._id.gets;

    if (newGets + newSends > 1500) {
        newGets *= .5;
        newSends *= .5;
    }

    let transaction = {
        from: from.username,
        from_id: from.id,
        to: u2.username,
        to_id: to,
        card: match,
        guild: guild.name,
        guild_id: guild.id,
        time: new Date()
    }

    mongodb.collection('transactions').insert(transaction);
    report(dbUser, transaction);
    report(u2, transaction);

    await collection.update(
        { discord_id: from.id }, {
            $set: {
                cards: dbUser.cards,
                dailystats: dbUser.dailystats,
                exp: fromExp,
                sends: newSends,
                gets: newGets
            }
        }
    );
    quest.checkSend(dbUser, match.level, callback);
    
    match.frozen = new Date();
    collection.update(
        { discord_id: to },
        {
            $set: { cards: u2.cards, dailystats: u2.dailystats },
            $inc: { gets: ratioIncrease }
        }
    ).then(() => {
        forge.getCardEffect(dbUser, 'send', u2, callback);
    });

    callback(utils.formatConfirm(from, "Sent successfully", "you sent **" + name + "** to **" + u2.username + "**\n"
        + "Recommended price for this card: **" + Math.floor(price) + "**🍅"));
}

//DEPRECATED
function pay(from, to, args, guild, callback) {
    return callback(utils.formatError(from, "Deprecated command", 
        "tomato transfer is not possible since 1.9.12\n"
        + "Other users should use `->sell @you card name` in order to sell you cards for fixed tomato price.\n"
        + "Learn more by running `->help sell`"));
    
    let collection = mongodb.collection('users');
    let amount = args.filter(a => utils.isInt(a))[0];

    if(!amount || !to) return;

    amount = Math.abs(amount);
    collection.findOne({ discord_id: from.id }).then(dbUser => {
        if(!dbUser) return;

        if(from.id == to) {
            callback("Did you actually think it would work?");
            return;
        }

        if(dbUser.exp >= amount) {
            collection.findOne({ discord_id: to }).then(user2 => {
                if(!user2) return;

                let ratio = amount/100;
                let transaction = {
                    from: dbUser.username,
                    from_id: dbUser.discord_id,
                    to: user2.username,
                    to_id: to,
                    exp: amount,
                    guild: guild.name,
                    guild_id: guild.id,
                    time: new Date()
                };

                dbUser.exp -= amount;
                user2.exp += amount;
                report(dbUser, transaction);
                report(user2, transaction);

                mongodb.collection('transactions').insert(transaction);
                collection.update({ discord_id: from.id }, {$inc: {exp: -amount, sends: ratio }});
                collection.update({ discord_id: to }, {$inc: {exp: amount, gets: ratio }});
                callback(utils.formatConfirm(dbUser, "Tomatoes sent", "you sent **" + amount + "**🍅 to **" + user2.username + "**"));
            });
            return;
        }
        callback(utils.formatError(dbUser.username, "Can't send Tomatoes", "you don't have enough funds"));
    });
}

//DEPRECATED
function sell(user, to, args, callback) {
    if(!args || args.length == 0) return callback("**" + user.username + "**, please specify name/collection/level");
    let query = utils.getRequestFromFilters(args);
    getUserCards(user.id, query).toArray((err, objs) => {
        if(!objs[0]) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        let cards = objs[0].cards;
        let match = query['cards.name']? getBestCardSorted(cards, query['cards.name'])[0] : cards[0];
        if(!match) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        if(match.fav && match.amount == 1) return callback(utils.formatError(user, null, "you can't sell favorite card." 
                + " To remove from favorites use `->fav remove [card query]`"));

        mongodb.collection('users').findOne({ discord_id: user.id }).then(dbUser => {

            heroes.addXP(dbUser, .3);
            let exp = forge.getCardEffect(dbUser, 'sell', settings.cardprice[match.level - 1])[0];
            dbUser.cards = removeCardFromUser(dbUser.cards, match);
            mongodb.collection('users').update(
                { discord_id: user.id },
                {
                    $set: {cards: dbUser.cards },
                    $inc: {exp: exp}
                }
            ).then(e => {
                let name = utils.toTitleCase(match.name.replace(/_/g, " "));
                callback(utils.formatConfirm(user, "Card sold to bot", "you sold **" + name + "** for **" + exp + "** 🍅"));

                report(dbUser, null, match);

                mongodb.collection('users').update(
                    { discord_id: user.id }, {$set: {dailystats: dbUser.dailystats}}
                );
            });
        });
    });
}

function daily(u, callback) {
    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: u.id }).then((user) => {
        if(!user) {
            collection.insert( { 
                discord_id: u.id,
                username: u.username,
                cards: [],
                exp: 2000,
                gets: 50,
                sends: 50
            }).then(() => {
                daily(u, callback);
            });
            return;
        }

        var stars = countCardLevels(user.cards);
        let amount = 300;
        
        if(user.dailystats && user.dailystats.claim) 
            amount = Math.max(heroes.getHeroEffect(user, 'daily', user.dailystats.claim), amount);

        let cardEffect = forge.getCardEffect(user, 'daily', amount, 20);
        amount = cardEffect[0];
        
        if(!user.hero) amount += 700;
        let hours = cardEffect[1] - utils.getHoursDifference(user.lastdaily);           
        if(hours && hours > 0) {
            if(hours == 1){
                let mins = 60 - (utils.getMinutesDifference(user.lastdaily) % 60);
                callback("**" + user.username + "**, you can claim daily 🍅 in **" + mins + " minutes**");
            } else 
                callback("**" + user.username + "**, you can claim daily 🍅 in **" + hours + " hours**");
            return;
        }

        heroes.addXP(user, 3);

        var msg = "**" + user.username + "** recieved daily **" + amount + "** 🍅 You now have " 
        + (Math.floor(user.exp) + amount) + "🍅 \n";

        if(!user.hero) msg += "(you got extra 700🍅 as a new player bonus)\n";
        else msg += "You also got **2 daily quests**. To view them use `->quests`\n";
        
        if(!user.hero && stars >= 50) 
            msg += "You have enough stars to get a hero! use `->hero list`\n";

        let incr = {exp: amount};
        if(user.gets > user.sends) incr.sends = 4;
        else if(user.gets < user.sends) incr.gets = 4;

        if(promotions.current > -1) {
            let promo = promotions.list[promotions.current];
            let tgexp = (user.dailystats? user.dailystats.claim * 80 : 0) + 500;
            incr.promoexp = tgexp;
            msg += "A special promotion is now going until **" + promo.ends + "**!\n"
                + "You got **" + tgexp + "** " + promo.currency + "\n"
                + "Use `->claim promo` to get special limited time cards";
        }

        let quests = user.hero? quest.getRandomQuests() : [];
        collection.update(
            { discord_id: u.id }, {
                $set: {lastdaily: new Date(), quests: quests, lastmsg: dailymessage.id, username: u.username},
                $unset: {dailystats: ""},
                $inc: incr
            }
        );

        callback(msg);

        if(user.lastmsg != dailymessage.id) {
            callback(utils.formatInfo(user, dailymessage.title, dailymessage.body));
        }
    });
}

function leaderboard(arg, guild, callback) {
    let global = arg == 'global';
    let collection = mongodb.collection('users');
    collection.aggregate([
        { $unwind : '$cards' },
        { $group : { _id : '$discord_id', 
            'username' : { $first : '$username'},
            'levels' : { $sum : '$cards.level' }}},
        //{ $limit : 10 },
        { $sort : { 'levels': -1 } }
    ]).toArray((err, users) => {
        if(err) return;

        if(global) {
            callback(utils.formatInfo(null, "Global TOP Card Masters:", nameOwners(users)));
        } else if(guild) {
            let includedUsers = [];
            try {
                users.map((elem) => {
                    var mem = guild.members[elem._id];
                    if(mem) includedUsers.push(elem);
                    if(includedUsers.length >= 10) throw BreakException;
                });
            } catch(e) {}

            if(includedUsers.length > 0) {
                callback(utils.formatInfo(null, "Local TOP Card Masters:", nameOwners(includedUsers)));
            }
        }
    });
}

function award(uID, amout, callback) {
    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: uID }).then((user) => {
        collection.update(
            { discord_id: uID },
            { $inc: {exp: amout} }
        );
        callback("**" + amout + "**🍅 were added to **" + user.username + "** balance");
    });
    
}

//{'cards.name':/Holy_Qua/},{$set:{'cards.$.name':'holy_quaternity'}}

function difference(discUser, parse, callback) {
    let targetID = parse.id;
    let args = parse.input;
    if(discUser.id == targetID) 
        return callback("Eh? That won't work");

    if(!targetID) return;

    let query = utils.getRequestFromFilters(args);
    getUserCards(discUser.id, {}).toArray((err, objs) => {
        let cardsU1 = objs[0]? objs[0].cards : [];
        let includeFavorite = false;
        if(query['cards.fav'] == true) {
            includeFavorite = true;
            delete query['cards.fav'];
        }

        getUserCards(targetID, query).toArray((err, objs2) => {
            if(!objs2[0]) 
                return callback(utils.formatError(discUser, null, "has no unique cards for you"));

            let cardsU2 = objs2[0].cards;
            let dbUser2 = objs2[0]._id;
            let dif = cardsU2.filter(x => cardsU1.filter(y => utils.cardsMatch(x, y)) == 0);
            if(includeFavorite != true) {
                dif = dif.filter(x => !(x.fav && x.amount == 1));
            }
            if(dif.length > 0) 
                callback(dif, dbUser2.username);
            else
                return callback(utils.formatError(discUser, null, "has no unique cards for you"));
        });
    });
}

function eval(user, args, callback, isPromo) {
    if(!args[0]) return;
    if(args.includes('-multi'))
        return callback(utils.formatError(user, "Request error", "flag `-multi` is not valid for this request"));

    let ccollection = isPromo ? mongodb.collection('promocards') : mongodb.collection('cards');

    let query = utils.getRequestFromFiltersNoPrefix(args);
    ccollection.find(query).toArray((err, res) => {
        let match = query.name? getBestCardSorted(res, query.name)[0] : res[0];
        if(!match) {
            if (!isPromo) return eval(user, args, callback, true);
            else          return callback(utils.formatError(user, null, "no cards found that match your request"));
        }

        getCardValue(match, price => {
            let name = utils.getFullCard(match);
            if(price == 0) callback(utils.formatInfo(user, null, "impossible to evaluate **" + name + "** since nobody has it"));
            else callback(utils.formatInfo(user, null, "the card **" + name + "** is worth **" + Math.floor(price) + "**🍅"));
        });
    });
}

function getCardValue(card, callback) {
    mongodb.collection('users').count({"cards":{"$elemMatch": utils.getCardQuery(card)}}).then(amount => {
        let price = (ratioInc.star[card.level] 
                    + (card.craft? ratioInc.craft : 0) + (card.animated? ratioInc.gif : 0)) * 100;
        
        if(amount > 0){
            price *= limitPriceGrowth((userCount * 0.035)/amount);
            return callback(price);
        }
        callback(0);
    });
}

function limitPriceGrowth(x) { 
    if(x<1) return x; 
    else if(x<10) return (Math.log(x)/1.3)+Math.sqrt(x)*(-0.013*Math.pow(x,2)+0.182*x+0.766); 
    else return Math.pow(x,0.2) + 4.25;
}

function getUserName(uID, callback) {
    let collection = mongodb.collection('users');
    collection.findOne({ discord_id: uID }).then((user) => {
        if(!user) return;
        callback(user.username);
    });
}

function removeCard(target, collection) {
    for(let i=0; i<collection.length; i++) {
        if(collection[i].name == target.name) {
            collection.splice(i, 1);
            return collection;
        }
    }
}

function doesUserHave(user, tgID, args, callback) {
    if(!tgID) return;

    let query = utils.getRequestFromFilters(args);
    getUserCards(tgID, query).toArray((err, objs) => {
        if(!objs[0]) 
            return callback(utils.formatError(user, null, "no cards found that match your request"));
        
        let cards = objs[0].cards;
        let match = query['cards.name']? getBestCardSorted(cards, query['cards.name'])[0] : cards[0];
        if(!match) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        let cardname = utils.toTitleCase(match.name.replace(/_/g, " "));
        if(match.fav == true)
            callback(utils.formatWarning(user, null, "matched card **" + cardname + "** but it is marked as favorite"));
        else 
            callback(utils.formatConfirm(user, null, "matched card **" + cardname + "**"));
    });
}

function needsCards(user, args, callback) {
    if(args.includes('-multi'))
        return callback(utils.formatError(user, "Request error", "flag `-multi` is not valid for this request"));

    let ccollection = args.filter(a => (a.includes('-halloween') || a.includes('-christmas') || a.includes('-valentine'))).length > 0? 
        mongodb.collection('promocards') : mongodb.collection('cards');

    let query = utils.getRequestFromFilters(args);
    getUserCards(user.id, query).toArray((err, objs) => {

        let cards;
        if(objs[0]) cards = objs[0].cards;
        else        cards = [];

        query = utils.getRequestFromFiltersNoPrefix(args);
        ccollection.find(query).toArray((err, res) => {
            let dif = res.filter(x => cards.filter(y => utils.cardsMatch(x, y)) == 0);
            
            if(dif.length > 0) 
                callback(dif, true);
            else if (cards.length == 0)
                callback(utils.formatError(user, null, "No cards were found that match your request"));
            else
                callback(utils.formatError(user, null, "You aren't missing any cards that match your request"));
        });
    });
}

function whohas(user, guild, args, callback) {
    let ucollection = mongodb.collection('users');
    let query = utils.getRequestFromFiltersNoPrefix(args);
    ucollection.find(
        {"cards":{"$elemMatch":query}}
    ).sort({"exp": 1}).toArray((err, arr) => {
        if(!arr || arr.length == 0) return callback(utils.formatError(user, null, "nobody has this card or it doesn't exist"));
        
        let msg = "\n";
        let local = [], glob = [], count = 1;
        for (var i = 0; i < arr.length; i++) {
            var mem = guild.members[arr[i].discord_id];
            if(mem) local.push(arr[i].username);
            else glob.push(arr[i].username);
        }

        for (var i = 0; i < local.length; i++) {
            msg += count + ". **" + local[i] + "**\n"; count++;
            if(count == 11) {
                msg += "And **" + (arr.length - 10) + "** more";
                break;
            };
        }

        if(count < 11) {
            for (var i = 0; i < glob.length; i++) {
                msg += count + ". " + glob[i] + "\n"; count++;
                if(count == 11) {
                    msg += "And **" + (arr.length - 10) + "** more";
                    break;
                };
            }
        }
        callback(utils.formatConfirm(null, "List of users, who have matching cards:", msg));
    });  
}

function fav(user, args, callback) {
    if(!args || args.length == 0) return callback("**" + user.username + "**, please specify card query");

    let remove = args[0] == 'remove';
    if(remove) args.shift();
    let query = utils.getRequestFromFilters(args);
    getUserCards(user.id, query).toArray((err, objs) => {
        if(!objs[0]) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        let cards = objs[0].cards;
        let dbUser = objs[0]._id;
        let matchCount = cards.length;

        if(!remove) cards = cards.filter(c => !c.fav);
        let match = query['cards.name']? getBestCardSorted(cards, query['cards.name'])[0] : cards[0];
        if(!match) 
            if(matchCount != cards.length)
                return callback(utils.formatError(user, null, "card is already favorited. Use `->fav remove [card]` to unfavorite"));
            else return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));

        query = {};
        query.discord_id = user.id;
        query.cards = { $elemMatch: utils.getCardQuery(match) };
        
        mongodb.collection('users').update(
            query,
            { $set: { "cards.$.fav": !remove }}
        ).then(e => {
            let name = utils.toTitleCase(match.name.replace(/_/g, " "));
            if(remove) callback(utils.formatConfirm(user, "Removed from favorites", "you removed **" + name + " [" + match.collection + "]** from favorites"));
            else callback(utils.formatConfirm(user, "Added to favorites", "you added **" + name + " [" + match.collection + "]** to favorites"));
        });
    });
}

function block(user, targetID, args, callback) {
    let ucollection = mongodb.collection('users');
    ucollection.findOne({discord_id: user.id}).then((dbUser) => {
        if(!dbUser) return;

        if(user.id == targetID)
            return callback("Ono you can't do that :c");

        if(args.length == 0 && !targetID)
            return callback(utils.formatError(user, null, "use `->block @user/id`"));

        if(args.includes("list")) {
            if(!dbUser.blocklist || dbUser.blocklist.length == 0)
                return callback(utils.formatInfo(user, null, "no users in your block list"));

            return ucollection.find({discord_id: {'$in': dbUser.blocklist}}).toArray((err, res) => {
                let phrase = "";
                let count = 1;
                res.map(foundUser => {
                    phrase += count + ". " + foundUser.username + "\n";
                    count++;
                });
                callback(utils.formatInfo(null, "List of users you blocked", phrase));
            });
        }

        ucollection.findOne({ discord_id: targetID }).then(u2 => { 
            if(!u2) return;

            if(args.includes("remove")) {
                if(dbUser.blocklist && dbUser.blocklist.includes(targetID)) {
                    return ucollection.update({discord_id: user.id}, {$pull: {blocklist: targetID}}).then(() => {
                        callback(utils.formatConfirm(user, null, "you have removed **" + u2.username + "** from your blocked user list"));
                    });
                } 
                return callback(utils.formatError(user, null, "can't find **" + u2.username + "** in your blocked user list"));
            }

            if(dbUser.blocklist && dbUser.blocklist.includes(targetID))
                return callback(utils.formatError(user, null, "you already blocked this user. To remove use `->block remove @user`"));

            if(dbUser.blocklist && dbUser.blocklist.length >= 20)
                return callback(utils.formatError(user, null, "you can't have more than **20** users blocked"));

            ucollection.update({discord_id: user.id}, {$push: {blocklist: targetID}}).then(() => {
                callback(utils.formatConfirm(user, "Success", "you have blocked **" + u2.username + "** from trading with you"));
            });
        });
    });
}

function track(user, targetID, channel, callback) {
    let ucollection = mongodb.collection('users');
    ucollection.findOne({discord_id: targetID}).then((dbUser) => {
        var remove = dbUser.tracked != null;
        var ch = remove? null : channel.id;
        ucollection.update({discord_id: targetID}, {$set: {tracked: ch}}).then(() => {
            if(remove) callback(utils.formatConfirm(null, "Success", "Transactions of **" + dbUser.username + "** are NOT reported now"));
            else callback(utils.formatConfirm(null, "Success", "Transactions of **" + dbUser.username + "** are now reported in this channel"));
        });
    });
}

function report(dbUser, transaction, soldcard) {
    if(dbUser.tracked) {
        if(transaction) {
            var tr = "**From:** " + transaction.from + " (" + transaction.from_id + ")\n";
            tr += "**To:** " + transaction.to + " (" + transaction.to_id + ")\n";
            tr += transaction.card? ("**Card:** " + transaction.card.name + " [" + transaction.card.collection + "]\n"): "";
            tr += transaction.exp? ("**Tomatoes:** " + transaction.exp + "\n"): "";
            tr += "**Guild:** " + transaction.guild + " (" + transaction.guild_id + ")\n";
            tr += "**" + dbUser.username + "'s balance:** " + Math.round(dbUser.exp);
            let res = utils.formatInfo(null, "Tracking report", tr);
            client.sendMessage({to: dbUser.tracked, embed: res});
        } else {
            let res = utils.formatInfo(null, "Tracking report", "**" + dbUser.username 
                + "** just sold card **" + soldcard.name + "[" + soldcard.collection +"]**");
            client.sendMessage({to: dbUser.tracked, embed: res});
        }
    }
}

function getUserCards(userID, query) {
    return mongodb.collection('users').aggregate([
        {"$match":{"discord_id":userID}},
        {"$unwind":"$cards"},
        {"$match":query},
        {"$group": {
            _id: {
                discord_id: "$discord_id", 
                username: "$username", 
                dailystats: "$dailystats",
                exp: "$exp",
                quests: "$quests",
                gets: "$gets",
                sends: "$sends"
            }, 
            cards: {"$push": "$cards"}}
        }
    ]);
}

function nameOwners(col) {
    let res = '';
    for(let i=0; i<col.length; i++) {
        res += (i+1).toString() + ". ";
        res += "**" + col[i].username + "**";
        res += " (" + col[i].levels + " ★)\n";
        if(i >= 9) break;
    }
    return res;
}

function dynamicSort(property) {
    var sortOrder = 1;
    if(property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}

function getClaimsAmount(dbUser, claims, exp) {
    let res = 0;
    let total = 0;
    let allowed = 20 - claims;

    while(true) {
        claims++;
        total += heroes.getHeroEffect(dbUser, 'claim_akari', claims * 50);
        if (total > exp) break;
        res++;
    }

    return Math.min(res, allowed);
}

function getClaimsCost(dbUser, amount) {
    let total = 0;
    let claims = dbUser.dailystats.claim;
    for (var i = 0; i < amount; i++) {
        claims++;
        total += heroes.getHeroEffect(dbUser, 'claim_akari', claims * 50);
    }
    return total;
}

function getPromoClaimsCost(dbUser, amount) {
    if(!dbUser.dailystats.promoclaim) 
        dbUser.dailystats.promoclaim = 1;

    let total = 0;
    let claims = dbUser.dailystats.promoclaim;
    for (var i = 0; i < amount; i++) {
        claims++;
        total += claims * 20;
    }
    return total;
}


function countCardLevels(cards) {
    let sum = 0;
    let metCards = [];
    if(!cards) return 0;
    cards.forEach(e => {
        if(metCards.filter(m => {
            return m.name == e.name && 
            m.collection == e.collection}).length == 0) {
            sum += e.level;
            metCards.push({
                name: e.name, 
                collection: e.collection
            });
        }
    }, this);
    return sum;
}

function getBestCardSorted(cards, n) {
    if(cards.length == 0) return [];
    
    let name;
    if(n instanceof RegExp) 
        name = n.toString().split('/')[1].replace('(_|^)', '').replace(/\?/g, '');
    else name = n.replace(' ', '_');

    let filtered = cards.filter(c => c.name.toLowerCase().includes(name));
    filtered.sort((a, b) => {
        let dist1 = lev(a.name, name);
        let dist2 = lev(b.name, name);
        if(dist1 < dist2) return -1;
        if(dist1 > dist2) return 1;
        else return 0;
    });

    if(filtered.length > 0) {
        name = name.replace(/\\/g, '');
        var re = new RegExp('^' + name);
        let supermatch = filtered.filter(c => re.exec(c.name.toLowerCase()));
        if(supermatch.length > 0) { 
            let left = filtered.filter(c => !supermatch.includes(c));
            return supermatch.concat(left);
        }
    }
    return filtered;
}

function getCardFile(card) {
    let ext = card.animated? '.gif' : (card.compressed? '.jpg' : '.png');
    let prefix = card.craft? card.level + 'cr' : card.level;
    let col = collections.filter(c => c.includes(card.collection))[0];
    return './cards/' + col + '/' + prefix + "_" + card.name + ext;
}

function getCardURL(card) {
    // if(card.animated && card.imgur) 
    //     return "https://i.imgur.com/" + card.imgur + ".gifv";

    let ext = card.animated? '.gif' : '.png';
    let prefix = card.craft? card.level + 'cr' : card.level;
    let col = collections.getByID(card.collection);
    if(!col) return "";

    let path = col.special? '/promo/' : '/cards/';
    if(!card.animated && col.compressed) ext = '.jpg';

    return "https://amusementclub.nyc3.digitaloceanspaces.com" 
        + path + col.id + '/' + prefix + "_" + card.name.toLowerCase() + ext;
}

function getDefaultChannel(g) {
    for (var key in g.channels) {
        if(g.channels[key].name.includes('general'))
            return g.channels[key];
    }

    for (var key in g.channels) {
        if(g.channels[key].permissions.user == {})
            return g.channels[key];
    }
}

function isAdmin(sender) {
    return settings.admins.includes(sender);
}

function addCardToUser(usercards, card) {
    var usercard = utils.containsCard(usercards, card);
    if(usercard) usercard.amount = (usercard.amount? usercard.amount + 1 : 2);
    else {
        card.amount = 1;
        usercards.push(card);
    }
    return usercards;
}

function removeCardFromUser(usercards, card) {
    var usercard = utils.containsCard(usercards, card);
    if(!usercard) return null;

    if(usercard.amount > 1) usercard.amount--;
    else {
        var i = usercards.indexOf(usercard);
        usercards.splice(i, 1);
    } 
    return usercards;
}

function getRandomCard(cards) {
    return _.sample(cards);
}

function getRandomJoke(user, callback) {
    fs.readdir('./april', (err, items) => {
        if(err) console.log(err);

        let item = _.sample(items);
        console.log(item);
        let name = item.split('.')[0].replace(/_/g, " ");
        callback("**" + user.username + "** you got **" + name + "**!", './april/' + item);
    });
}
