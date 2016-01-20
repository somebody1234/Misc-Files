'use strict'
var Promise = require('bluebird')

const db = require('../database')
var knex = db.knex

const erma = require('../lib/ermagerd').ermagherd
const math = require('../lib/utils').math
const r_engine = math.engine
const Random = math.Random
const serialize_chat = db.common.serialize_chat



const DEFAULT_CMD = 'chat'

const PERMISSION = {
	all: () => true,
	mod: (user) => user.staff_level > 0,
	community: (user) => user.staff_level > 1,
	admin: (user) => user.staff_level > 2,
	owner: (user) => user.staff_level > 3
}

const broadcast = function(msg) {
	this.server.broadcast('c', serialize_chat(msg), msg.room)
}

const GameError = require('./util').GameError

const PRERUN = {
	private_: function(msg) { return Promise.resolve(msg) }, // no-op
	public_: function(msg) {
		msg['public'] = true
		return Promise.resolve(msg)
	},
	private_get_user: function(msg) {
		let args = parse_arg(msg.text)
		let username = args[0]
		let text = args[1]
		msg.text = text

		return knex('user')
			.where('username', username).first()
			.then(function(user){
				if (!user)
					return Promise.reject(
						new GameError(
							'Player named ' + username + ' was not found.', 'not_found'))

				msg.target_id = user.id
				msg.target = user.username
				return msg
			})
	},
	private_get_user_not_staff: function(msg) {
		let args = parse_arg(msg.text)
		let username = args[0]
		let text = args[1]
		msg.text = text

		return knex('user')
			.where('username', username).first()
			.then(function(user){
				if (!user)
					return Promise.reject(
						new GameError(
							'Player named ' + username + ' was not found.', 'not_found'))

				if (user.staff_level > 0)
					return Promise.reject(
						new GameError(
							'You cannot do that to a staff member.'))

				msg.target_id = user.id
				msg.target = user.username
				return msg
			})
	}
}

const cmds = {
	chat: {
		name: 'c',
		permission: PERMISSION.all,
		prerun: PRERUN.public_,
		run: function(msg, user) {
			msg.text = modify(user, msg.text)
			this.server.broadcast('c', serialize_chat(msg), msg.room)
		},
		room: true
	},
	whisper: {
		name: 'w',
		help: 'Private message',
		usage: '/w playername message',
		permission: PERMISSION.all,
		prerun: function(msg) {
			return PRERUN.private_get_user.call(this, msg)
				.then(() => {
					if (msg.target_id !== msg.user_id) 
						return msg

					return Promise.reject(new GameError('Why you talkin to yourself?'))
				})
		},
		run: function(msg, user) {
			msg.text = modify(user, msg.text)
			this.server.broadcast('c', serialize_chat(msg), 'u'+msg.target_id)
			this.emit2('c', serialize_chat(msg))

			return Promise.all([
				knex('user')
					.update('respond', JSON.stringify([msg.target_id, msg.target]))
					.where('id', msg.user_id),
				knex('user')
					.update('respond', JSON.stringify([msg.user_id, msg.user]))
					.where('id', msg.target_id)
			])

		}
	},
	respond: {
		name: 'r',
		help: 'Respond/continue last private message',
		usage: '/r message',
		permission: PERMISSION.all,
		prerun: function(msg) {

			return knex('user')
				.where('id', msg.user_id).first()
				.then(function(user) {
					let respond;
					try {
						respond = JSON.parse(user.respond)
						msg.target_id = respond[0]
						msg.target = respond[1]

					} catch(e) {
						return Promise.reject(new GameError('No current conversation.'))
					}

					return msg
				})

		},
		run: function(msg, user) {
			msg.text = modify(user, msg.text)

			this.server.broadcast('c', serialize_chat(msg), 'u'+msg.target_id)
			if (msg.target_id !== msg.user_id)
				this.emit2('c', serialize_chat(msg))
		}
	},
	me: {
		name: 'm',
		help: 'Emote',
		usage: '/me message',
		permission: PERMISSION.all,
		prerun: PRERUN.public_,
		run: broadcast,
		room: true
	},
	my: {
		name: 'my',
		help: 'Possessive Emote',
		usage: '/my message',
		permission: PERMISSION.all,
		prerun: PRERUN.public_,
		run: broadcast,
		room: true
	},

	flip: {
		name: 'flip',
		help: 'Flip the coins',
		usage: '/flip OR /flip 100',
		permission: PERMISSION.all,
		prerun: function(msg) {
			let coins = parse_arg(msg.text)[0]
			let max_coins = 1000000

			if (coins === 'max') {
				coins = max_coins
			} else if (!coins) {
				coins = 1
			} else {
				coins = parseInt(coins)
				if (isNaN(coins)) coins = 1
			}

			coins = Math.max(1, Math.min(max_coins, coins))
	
			let heads = 0
			for (var i = 0; i < coins; i++) {
				if (math.bool(r_engine))
					heads++;
			}

			if (coins === 1) {
				msg.text = 'flipped a coin and got ' + (heads ? 'heads' : 'tails') + '.'
			} else {
				msg.text = `flipped ${heads} heads and ${coins - heads} tails` +
					` in ${coins} coin flips.`
			}
			msg['public'] = true;
			return Promise.resolve(msg)
		},
		run: broadcast,
		room: true
	},
	roll: {
		name: 'roll',
		help: 'Roll the dice',
		usage: '/roll 0-100 OR /roll 100 OR /roll OR /roll max OR /roll 10d10',
		permission: PERMISSION.all,
		prerun: function(msg) {
			let max_allowed = 10000000000
			let text = msg.text.trim()

			let things = [];
			let tmp = /^(\d+)\s*([d-])?\s*(\d+)?$/.exec(text)

			if (tmp) {
				tmp[1] && things.push(tmp[1])
				tmp[2] && things.push(tmp[2])
				tmp[3] && things.push(tmp[3])
			}

			let min = 0
			let max = 100

			let is_dice = false

			if (things.length) {
				if (things.length === 3) {
					if(things[1] === 'd') {
						is_dice = true
						// min is dice count, max is sides
						min = parseInt(things[0])
						max = parseInt(things[2])

						let max_dice = 500
						if (min > max_dice) {
							min = max_dice
						}

						let max_sides = Math.ceil(max_allowed / min)
						if (max > max_sides) {
							max = max_sides
						}

					} else {
						min = parseInt(things[0])
						max = parseInt(things[2])
					}
				} else if (things.length === 2) {
					min = parseInt(things[0])
					max = parseInt(things[1])
				} else {
					max = parseInt(things[0])
				}

				if (!is_dice && !isNaN(min) && !isNaN(max)) {
					max = Math.min(max_allowed, max)
					min = Math.min(max_allowed, min)
					
					if (max < min) {
						let tmp = min
						min = max
						max = tmp
					}
				}

			} else if (text.length) {
				max = text === 'max' ? max_allowed : NaN;
			}

			if (isNaN(min) || isNaN(max) || (min === max && !is_dice)) {
				return Promise.reject(
					new GameError('That is not a valid dice roll (/roll ' + msg.text + ').'))
			}

			if (is_dice) {
				// min is dice count, max is sides
				let result = Random.dice(max, min)(r_engine)
				msg.text = 'rolled a ' + result.reduce((p, c) => p + c);

				if (min > 12) {
					msg.text += ' [too many to show] '
				} else {
					msg.text += ' [' + result.join(', ') + '] '
				}
				msg.text += '(' + min + 'd' + max + ').'

			} else {
				let result = Random.integer(min, max)(r_engine)
				msg.text = 'rolled a ' + result + ' (' + min + '-' + max + ').'
			}

			msg['public'] = true
			return Promise.resolve(msg)
		},
		run: broadcast,
		room: true
	},
	announce: {
		name: 'ann',
		help: '(mod) Make official announcement',
		usage: '/ann message',
		permission: PERMISSION.mod,
		prerun: PRERUN.public_,
		run: broadcast
	},
	warn: {
		name: 'warn',
		help: '(mod) Make official warning',
		usage: '/warn message',
		permission: PERMISSION.mod,
		prerun: PRERUN.public_,
		run: broadcast
	},
	kick: {
		name: 'kick',
		help: '(mods) Kick player',
		usage: '/kick playername',
		permission: PERMISSION.mod,
		prerun: PRERUN.private_get_user_not_staff,
		run: function(msg) {
			this.server.get_user_socket(msg.target_id).forEach((sock) => {
				sock.emit2('k', msg)
				sock.close()
			})

			if (msg.target_id !== msg.user_id)
				this.emit2('c', serialize_chat(msg))
		}
	},
	effect: {
		name: 'effect',
		help: '(mod) sets/unsets chat effects on a player',
		permission: PERMISSION.admin,
		prerun: PRERUN.private_get_user,
		run: function(msg) {
			let effect = msg.text
			if (!effects[effect]) {
				return Promise.reject(
					new GameError('Chat effect not found.', 'chat_effect'))
			}
			
			return knex('user').columns(effect).where('id', msg.target_id).first()
				.then((user) => {
					return knex('user')
						.update(effect, !user.effects[effect])
						.where('id', msg.target_id)
				})
				.then(() => {
					this.server.broadcast('c', serialize_chat(msg), 'u'+msg.target_id)
					if (msg.target_id !== msg.user_id)
						this.emit2('c', serialize_chat(msg))
				})
		}
	},
	setstaff: {
		name: 'setstaff',
		help: '(community) sets staff level on a player. Max: your staff level - 1.',
		usage: '/setstaff playername stafflevel',
		permission: PERMISSION.community,
		prerun: PRERUN.private_get_user,
		run: function(msg) {
			let level = parseInt(parse_arg(msg.text)[0])

			if (isNaN(level) || level < 0 || level > 4)
				return Promise.reject(
					new GameError(
						'Invalid staff rank specified.',
						'staff'))

			level = Math.max(0, level)

			return knex('user').where('id', msg.target_id).first()
				.then((user) => {
					if (user.staff_level >= msg.user_staff)
						return Promise.reject(
							new GameError(
								'You cannot modify staff rank of someone equal to you.',
								'staff'))

					if (level >= msg.user_staff)
						return Promise.reject(
							new GameError(
								'You can only set staff rank up to one lower than your rank',
								'staff'))

					return knex('user')
						.update('staff_level', level)
						.where('id', user.id)
				})
				.then(() => {
					this.server.broadcast('sys', msg, 'u'+msg.target_id)
					this.emit2('sys', msg)
				})
		}
	},
	refresh: {
		name: 'refresh',
		help: '(admins) force global page refresh',
		usage: '/refresh',
		permission: PERMISSION.admin,
		prerun: PRERUN.private_,
		run: function() {
			this.server.broadcast('refresh')
		}
	},
	nick: {
		name: 'nick',
		help: '(owner) change player username',
		usage: '/nick oldname newname',
		permission: PERMISSION.owner,
		prerun: PRERUN.private_get_user,
		run: function(msg) {
			let newNick = parse_arg(msg.text)[0]
			return knex('user')
			.where('id', msg.target_id)
			.update('username', newNick)
			.then(() => {
				this.server.broadcast('nick', newNick, 'u'+msg.target_id)
				this.emit2('c', serialize_chat(msg))
			})
		}
	},
	profile: {
		name: 'profile',
		help: 'View a player's profile',
		usage: '/profile playername',
		permission: PERMISSION.all,
		nosave: true,
		prerun: PRERUN.private_get_user,
		run: function(msg) {
			this.emit2('profile', msg.target_id)
		}
	},
	ignore: {
		name: 'ignore',
		help: 'Ignore a user',
		usage: '/ignore playername',
		permission: PERMISSION.all,
		nosave: true,
		prerun: function(msg) {
			return PRERUN.private_get_user.call(this, msg)
				.then(() => {
					if (msg.target_id !== msg.user_id) 
						return msg

					return Promise.reject(
						new GameError('Try as you might, you can\'t ignore yourself.'))
				})
		},
		run: function(msg, user) {
			return knex('user_ignore')
			.where('user_id', user.id)
			.where('ignore_id', msg.target_id)
			.first()
			.then((ignore) => {
				if (ignore)
					return Promise.reject(
						new GameError('Already ignoring that user.'))

				return knex('user_ignore').insert({
					user_id: user.id,
					ignore_id: msg.target_id
				})
			})
			.then(() => {
				this.emit2('ignore', msg)
			})
		}
	},
	unignore: {
		name: 'unignore',
		help: 'Stop ignoring a user',
		usage: '/unignore playername',
		permission: PERMISSION.all,
		nosave: true,
		prerun: function(msg) {
			return PRERUN.private_get_user.call(this, msg)
				.then(() => {
					if (msg.target_id !== msg.user_id) 
						return msg

					return Promise.reject(
						new GameError(
							'You never stopped listening to yourself, stop that.'))
				})
		},
		run: function(msg, user) {
			return knex('user_ignore')
			.where('user_id', user.id)
			.where('ignore_id', msg.target_id)
			.first()
			.then((ignore) => {
				if (!ignore)
					return Promise.reject(
						new GameError('Not currently ignoring that user.'))

				return knex('user_ignore')
					.where('user_id', user.id)
					.where('ignore_id', msg.target_id)
					.del()
			})
			.then(() => {
				this.emit2('unignore', msg)
			})
		}
	},
	ignorelist: {
		name: 'ignorelist',
		help: 'List ignored users',
		usage: '/ignorelist',
		permission: PERMISSION.all,
		nosave: true,
		prerun: PRERUN.private_,
		run: function(msg, user) {
			return knex('user_ignore')
			.select('user.username')
			.where('user_ignore.user_id', user.id)
			.join('user', 'user_ignore.ignore_id', 'user.id')
			.pluck('username')
			.then((ignorelist) => {
				msg.text = 'Currently ignoring: ' + ignorelist.join(', ');
				this.emit2('sys', msg)
			})
		}
	}
}

const aliases = {
	c: cmds.chat,
	w: cmds.whisper,
	r: cmds.respond,
	p: cmds.profile,
	ann: cmds.announce
}

module.exports.cmds = cmds

module.exports.parse = function parse(text) {
	let cmd;

	if (text.charAt(0) === '/') {
		let space_idx = text.indexOf(' ')
		let cmdtxt = text.substring(1, space_idx === -1 ? text.length : space_idx).toLowerCase()
		let tmp = cmds[cmdtxt] || aliases[cmdtxt]

		if (tmp) {
			cmd = tmp
			text = space_idx === -1 ? '' : text.substring(space_idx + 1)
		}
	} else {
		cmd = cmds[DEFAULT_CMD]
	}

	return {cmd, text}
}

function parse_arg(text) {
	text = text.trim()
	let space_idx = text.indexOf(' ')

	return space_idx === -1 ?
		[text, ''] :
		[text.substring(0, space_idx), text.substring(space_idx + 1)]
}

module.exports.parse_arg = parse_arg

module.exports.help = Object.keys(cmds)
	.filter((k) => !!cmds[k].help)
	.map((k) => [k, cmds[k].help, cmds[k].usage])

module.exports.help.push(
	['m', 'Talk in main channel', '/m message'],
	['s', 'Talk in staff channel', '/s message'],
	['g', 'Talk in guild channel', '/g message']
)

var effects = {
    yoda: 0x01,
    ip: 0x02,
    pirate: 0x04,
    derp: 0x08,
    shout: 0x10,
    pig: 0x20
}

function modify(user, message) {
  var ef = user.effects'
  if (ef & effects.yoda) message = yoda(message);
  if (ef & effects.ip) message = inappropriate_prepositions(message);
  if (ef & effects.pirate) message = pirate(message);
  if (ef & effects.derp) message = erma.gherd(message);
  if ((ef & effects.shout) && !(ef & effects.derp)) message = message.toUpperCase();
  if (ef & effects.pig) message = pig_latin(message);
  return message;
}
pig_latin = function(english) {
  english = '' + english
  var split_words = english.split(' '),
      pig_latin = '',
      split_words_pig_latin = []
  split_words.forEach(function(word){
    var consonant_start_pattern = /^[^a-z]*(([bcdfghjklmnpqrstvwxyz]){1}([a-z']*))/i,
        consonant_matches = word.match(consonant_start_pattern),
        vowel_start_pattern = /^[^a-z]*(([aeiou]){1}([a-z']*))/i,
        vowel_matches = word.match(vowel_start_pattern),
        orig_word, rebuilt_word = null
    var consistent_cases = function(matches) {
      if (/[A-Z]/.test(matches[2]) && matches[3].length > 0) {
        if (matches[3] !== matches[3].toUpperCase()) matches[2] = matches[2].toLowerCase()
        matches[3] = matches[3].replace(/^[a-z]{1}/, matches[3][0].toUpperCase())
      }
    }
    if (consonant_matches !== null) {
      consistent_cases(consonant_matches)
      orig_word = consonant_matches[1]
      rebuilt_word = '' + consonant_matches[3] + consonant_matches[2] + 'ay'
    }
    else if (vowel_matches !== null) {
      consistent_cases(vowel_matches)
      orig_word = vowel_matches[1]
      rebuilt_word = '' + vowel_matches[3] + vowel_matches[2] + 'hay'
    }
    if (rebuilt_word) {
      word = word.replace(orig_word, rebuilt_word)
    }
    split_words_pig_latin.push(word)
  })  
  pig_latin = split_words_pig_latin.join(' ')
  return pig_latin
}
var pirate_phrases = [["hello", "ahoy"], ["hi", "yo-ho-ho"], ["pardon me", "avast"], 
           ["excuse me", "arrr"], ["yes", "aye"],
           ["my", "me"], ["friend", "me bucko"], ["sir", "matey"], 
           ["madam", "proud beauty"], ["miss", "comely wench"], 
           ["stranger", "scurvy dog"], ["officer", "foul blaggart"], 
           ["where", "whar"], ["is", "be"], ["are", "be"], ["am", "be"], 
           ["the", "th'"], ["you", "ye"], ["your", "yer"],
           ["tell", "be tellin'"], ["know", "be knowin'"],
           ["how far", "how many leagues"], ["old", "barnacle-covered"],
           ["attractive", "comely"], ["happy", "grog-filled"], ["quickly", "smartly"],
           ["nearby", "broadside"], ["restroom", "head"], ["restaurant", "galley"],
           ["hotel", "fleabag inn"], ["pub", "Skull & Scuppers"], ["mall", "market"],
           ["bank", "buried treasure"], ["die", "visit Davey Jones' Locker"],
           ["died", "visited Davey Jones' Locker"], ["kill", "keel-haul"],
           ["killed", "keel-hauled"], ["sleep", "take a caulk"],
           ["stupid", "addled"], ["after", "aft"], ["stop", "belay"],
           ["nonsense", "bilge"], ["officer", "bosun"], ["ocean", "briny deep"],
           ["song", "shanty"], ["money", "doubloons"], ["food", "grub"],
           ["nose", "prow"], ["leave", "weigh anchor"], ["cheat", "hornswaggle"],
           ["forward", "fore"], ["child", "sprog"], ["children", "sprogs"],
           ["sailor", "swab"], ["lean", "careen"], ["find", "come across"],
           ["mother", "dear ol' mum, bless her black soul"],
           ["drink", "barrel o' rum"], ["of", "o'"]
          ];
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.substring(1);
}
function pirate(msg)
{
    for (var i = 0; i < phrases.length; i++) {
        var to_replace = new RegExp("\\b"+pirate_phrases[i][0]+"\\b", "i");
        
        var index = msg.search(to_replace);
        while (index != -1) {
           if (msg.charAt(index) >= "A" && msg.charAt(index) <= "Z") {
               msg = msg.replace(to_replace, capitalize(pirate_phrases[i][1]));
           } 
           else {
               msg = msg.replace(to_replace, pirate_phrases[i][1]);
           }
           index = msg.search(to_replace);
        }
    }
    return msg;
}
function yodafy(str) {
  var s = this.setcase(this.trim(str));
  var ns;
  var dot = "";
  var p = s.match(/!|\?|\./) || "";
  var occur = s.match(/\s(is|be|will|show|do|try|are|teach|have)\s/);
  if (occur) {    
    if (p) {
      s = s.substring(0, s.length-1);
      dot = p;
    }
    s = s.split(occur[0]);
    occur[0] = occur[0].substring(1, occur[0].length-1);
    ns = s[1] + ", ";
    s[1] = "";
    ns += s.join(" "+occur[0]+" ");
    ns = ns.substring(0, ns.length-1)+dot;
    ns = this.setcase(ns, "upper");
  } else {
    ns = this.setcase(s, "upper");
  }
  return ns;
}
function trim(s) {
  s = s.replace(/^\s+|\s+$/g, "");
  s = s.replace(/^#/, "");
  return s.replace(/^\s+|\s+$/g, "");
}
function setcase(l, casing) {
  l = l.split('');
  l[0] = (casing == "upper") ? l[0].toUpperCase() : l[0].toLowerCase();
  l = l.join('');
  var fp = l.match(/\si\s/);
  if (fp) {
    l = l.split(fp);l = l[0]+" I "+l[1];
  }
  return l;
}
function yoda(str) {
  var s = str.replace(/(!|\?|\.)/g, '$1\n').split('\n');
  if (s[s.length-1] == "") {var bla = s.pop();}
  var se = s.length;
  for (var i=0;i<se;i++) {
    if(s[i] != "\r") {
       s[i] = this.yodafy(s[i]);
    }
  }
  return s.join(" ");
}
var prepositions = ['about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'at', 'before', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'by', 'down', 'during', 'except', 'for', 'from', 'in', 'inside', 'into', 'like', 'near', 'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'through', 'throughout', 'to', 'under', 'up', 'upon', 'with', 'within', 'without']
function inappropriate_prepositions(paragraph) {
  var words = paragraph.split(' ')
  var len = prepositions.length
  for(var i = 0; i < words.length; i++) {
    if(prepositions.indexOf(word) !== -1) {
      words[i] = prepositions[Math.random(len)]
    }
  }
  return words.join(' ')
}
var homophones = [['acts','ax','axe'],['ad','add'],['adds','ads','adze'],['ade','aid','aide'],['aerie','airy'],['aero','arrow'],['affect','effect'],['ail','ale'],['air','e\'er','ere','err','heir'],['aisle','I\'ll','isle'],['all','awl'],['allowed','aloud'],['altar','alter'],['ant','aunt'],['ante','auntie'],['arc','ark'],['ascent','assent'],['ate','eight'],['auger','augur'],['aught','ought'],['aural','oral'],['auricle','oracle'],['away','aweigh'],['awed','odd'],['aweful','awful','offal'],['aye','eye','I'],['bail','bale'],['bailed','baled'],['bailee','bailey','bailie'],['bailer','bailor','baler'],['bailing','baling'],['bait','bate'],['baited','bated'],['baiting','bating'],['bald','balled','bawled'],['ball','bawl'],['band','banned'],['bard','barred'],['bare','bear'],['bark','barque'],['baron','barren'],['berry','bury'],['basal','basil'],['base','bass'],['based','baste'],['bases','basis','basses'],['bask','basque'],['bat','batt'],['baud','bawd'],['be','bee'],['beach','beech'],['beat','beet'],['beau','bow'],['beaut','butte'],['been','bin'],['beer','bier'],['bell','belle'],['berth','birth'],['besot','besought'],['better','bettor'],['bight','bite','byte'],['billed','build'],['blew','blue'],['bloc','block'],['boar','boor','bore'],['board','bored'],['boarder','border'],['bode','bowed'],['bold','bowled'],['bolder','boulder'],['bole','boll','bowl'],['boos','booze'],['born','borne','bourn'],['borough','burrow'],['bough','bow'],['buoy','boy'],['bra','braw'],['braid','brayed'],['braise','brays'],['brake','break'],['breach','breech'],['bread','bred'],['brewed','brood'],['brews','bruise'],['bridal','bridle'],['broach','brooch'],['brows','browse'],['bundt','bunt'],['burger','burgher'],['bus','buss'],['bussed','bust'],['but','butt'],['buy','by','bye'],['buyer','byre'],['cache','cash'],['cached','cashed'],['call','caul'],['cocked','caulked'],['cocksucker','caulksucker'],['half-cocked','half-caulked'],['caller','collar'],['can\'t','cant'],['cannon','canon'],['canter','cantor'],['canvas','canvass'],['capital','capitol'],['carat','caret','carrot','karat'],['carol','carrel'],['carpal','carpel'],['cast','caste'],['caster','castor'],['cause','caws'],['cedar','seeder'],['cede','seed'],['ceding','seeding'],['ceiling','sealing'],['cel','cell','sell'],['cellar','seller'],['censer','censor','sensor'],['census','senses'],['cent','scent','sent'],['cents','scents','sense'],['sear','seer','sere'],['cereal','serial'],['cession','session'],['chalk','chock'],['chance','chants'],['chard','charred'],['chased','chaste'],['chews','choose'],['chili','chilly'],['choir','quire'],['choler','collar'],['choral','coral'],['chorale','corral'],['chord','cord','cored'],['chute','shoot'],['cite','sight','site'],['cited','sighted','sited'],['cites','sights','sites'],['clack','claque'],['clause','claws'],['clew','clue'],['click','clique'],['climb','clime'],['close','clothes'],['coal','cole'],['coaled','cold'],['coarse','course'],['coat','cote'],['coax','cokes'],['cock','caulk',],['cocks','cox','caulks'],['coddling','codling'],['coffer','cougher'],['coin','quoin'],['colonel','kernel'],['complement','compliment'],['conch','conk'],['coo','coup'],['copes','copse'],['copped','copt'],['cops','copse'],['core','corps'],['cosign','cosine'],['council','counsel'],['creak','creek'],['crewed','crude'],['crews','cruise'],['cue','queue'],['currant','current'],['curser','cursor'],['cygnet','signet'],['cymbal','symbol'],['dam','damn'],['dammed','damned'],['darn','darne'],['days','daze'],['dear','deer'],['dew','do','due'],['die','dye'],['died','dyed'],['dies','dyes'],['dine','dyne'],['dire','dyer'],['dike','dyke'],['disc','disk'],['discreet','discrete'],['discussed','disgust'],['doe','dough'],['doc','dock'],['doughs','doze'],['done','dun'],['dos','dues'],['draft','draught'],['dual','duel'],['earl','url'],['earn','urn'],['elicit','illicit'],['elude','allude'],['epic','epoch'],['eunuchs','unix'],['ewe','yew','you'],['ewes','use','yews'],['eyelet','islet'],['facts','fax'],['fain','feign'],['faint','feint'],['fair','fare'],['fairing','faring'],['fairy','ferry'],['faker','fakir'],['farrow','pharoah'],['faux','foe'],['fays','faze','phase'],['fazed','phased'],['feat','feet'],['ferrate','ferret'],['feted','fetid'],['few','phew'],['file','phial'],['fills','fils'],['filter','philter'],['find','fined'],['fir','fur'],['fisher','fissure'],['flair','flare'],['flea','flee'],['flecks','flex'],['flew','flu','flue'],['floe','flow'],['flocks','phlox'],['floes','flows'],['floor','fluor'],['flour','flower'],['for','fore','four'],['foreword','forward'],['fort','forte'],['forth','fourth'],['foul','fowl'],['frees','freeze','frieze'],['friar','fryer'],['gaff','gaffe'],['gage','gauge'],['gait','gate'],['gaited','gated'],['galley','gally'],['gays','gaze'],['gene','jean'],['gild','gilled','guild'],['gilt','guilt'],['gin','djinn'],['gnawed','nod'],['gneiss','nice'],['gnu','knew','new'],['gnus','news'],['gored','gourd'],['gorilla','guerrilla'],['grade','grayed'],['graft','graphed'],['grate','great'],['grays','graze'],['greave','grieve'],['greaves','grieves'],['grill','grille'],['groan','grown'],['guessed','guest'],['guide','guyed'],['guise','guys'],['gunnel','gunwale'],['hail','hale'],['hair','hare'],['hairy','harry'],['hall','haul'],['halve','have'],['halves','haves'],['hammock','hummock'],['hangar','hanger'],['hart','heart'],['haut','ho','hoe'],['hay','hey'],['hays','haze'],['he\'d','heed'],['he\'ll','heal','heel'],['hear','here'],['heard','herd'],['heigh','hi','hie','high'],['heroin','heroine'],['hew','hue'],['hide','hied'],['higher','hire'],['him','hymn'],['hoar','whore'],['hoard','horde','whored'],['hoarse','horse'],['hoes','hose'],['hold','holed'],['hole','whole'],['holey','holy','wholly'],['hostel','hostile'],['hour','our'],['hours','ours'],['humerus','humorous'],['idle','idol','idyll'],['in','inn'],['inc','ink'],['incite','insight'],['innocence','innocents'],['inns','ins'],['jam','jamb'],['jewel','joule'],['juggler','jugular'],['knap','nap'],['knead','need'],['knickers','nickers'],['knight','night'],['knit','nit'],['knits','nits'],['knob','nob'],['knock','nock'],['knot','naught','not'],['know','no'],['knows','noes','nose'],['lacks','lax'],['lain','lane'],['lam','lamb'],['lay','lei'],['lays','laze','leis'],['lea','lee'],['leach','leech'],['lead','led'],['leak','leek'],['lean','lien'],['leas','lees'],['leased','least'],['lends','lens'],['lessen','lesson'],['liar','lyre'],['lichen','liken'],['lie','lye'],['lieu','loo'],['lightening','lightning'],['limb','limn'],['limbs','limns'],['links','lynx'],['literal','littoral'],['lo','low'],['load','lode','lowed'],['loan','lone'],['loch','lock'],['lochs','locks','lox'],['loon','lune'],['loop','loupe'],['loos','lose'],['loot','lute'],['lumbar','lumber'],['mach','mock'],['made','maid'],['mail','male'],['main','mane'],['maize','maze'],['mall','maul','moll'],['manner','manor'],['marc','mark','marque'],['marquee','marquis'],['marry','merry'],['marshal','martial'],['massed','mast'],['maize','maze'],['me','mi'],['mean','mien'],['meat','meet','mete'],['medal','meddle','mettle','metal'],['men\'s','mends','mens\''],['mewl','mule'],['mews','muse'],['might','mite'],['mince','mints'],['mind','mined'],['miner','minor'],['missal','missile'],['missed','mist'],['misses','Mrs.'],['moan','mown'],['moat','mote'],['mode','mowed'],['mood','mooed'],['moor','more'],['moose','mousse'],['moral','morel'],['morn','mourn'],['morning','mourning'],['muscle','mussel'],['muscles','mussels'],['mussed','must'],['mustard','mustered'],['naval','navel'],['nay','neigh'],['nays','neighs'],['neap','neep'],['none','nun'],['oar','or','ore'],['oh','owe'],['ohs','owes'],['one','won'],['oohs','ooze'],['ordinance','ordnance'],['overdo','overdue'],['paced','paste'],['packed','pact'],['pail','pale'],['pain','pane'],['pair','pare','pear'],['palate','pallet','pallette'],['passed','past'],['patience','patients'],['pause','paws'],['pea','pee'],['peace','piece'],['peak','peek','pique'],['peal','peel'],['pealed','peeled'],['pearl','purl','perl'],['pedal','peddle'],['peer','pier'],['per','purr'],['pi','pie'],['pieced','piste'],['pincer','pincher','pinscher'],['pistil','pistol'],['place','plaice'],['plain','plane'],['plait','plate'],['planar','planer'],['pleas','please'],['pleural','plural'],['plum','plumb'],['polar','poler'],['pole','poll'],['poled','polled'],['poor','pore','pour'],['popery','potpourri'],['praise','prays','preys'],['pray','prey'],['precedence','precedents','presidents'],['presence','presents'],['pride','pryed'],['pries','prize'],['prince','prints'],['principal','principle'],['profit','prophet'],['pros','prose'],['psi','sigh','xi'],['quarts','quartz'],['quince','quints'],['rabbet','rabbit'],['rack','wrack'],['racket','racquet'],['rain','reign','rein'],['raise','rays','raze'],['rap','wrap'],['rapped','rapt','wrapped'],['ray','re'],['read','red'],['read','rede','reed'],['reading','reeding'],['reads','reeds'],['real','reel'],['recede','reseed'],['reck','wreck'],['reek','wreak'],['resinate','resonate'],['resisters','resistors'],['rest','wrest'],['retch','wretch'],['review','revue'],['rheum','room'],['rheumy','roomie','roomy'],['rho','roe','row'],['rhumb','rum'],['rhyme','rime'],['rigger','rigor'],['right','rite','wright','write'],['ring','wring'],['rise','ryes'],['road','rode','rowed'],['roil','royal'],['role','roll'],['rood','rude'],['roomer','rumor'],['root','route'],['rose','rows'],['rot','wrought'],['rote','wrote'],['rough','ruff'],['rout','route'],['roux','rue'],['rude','rued'],['rye','wry'],['sachet','sashay'],['sacks','sax'],['sail','sale'],['sane','seine'],['saner','seiner'],['saver','savor'],['sawed','sod'],['scene','seen'],['scull','skull'],['sea','see'],['seal','seel'],['seam','seem'],['seamen','semen'],['seams','seems'],['sear','seer'],['seas','sees','seize'],['sects','sex'],['seek','sikh'],['serf','surf'],['serge','surge'],['sew','so','sow'],['sewer','sower'],['sewer','suer'],['shake','sheik'],['shall','shell'],['she\'ll','shill'],['shear','sheer'],['shears','sheers'],['sheave','shiv'],['shoe','shoo'],['shoes','shoos'],['sic','sick'],['sics','six'],['side','sighed'],['sighs','size'],['sign','sine'],['sink','synch'],['sioux','sou','sough','sue'],['slay','sleigh'],['sleight','slight'],['slew','slough','slue'],['sloe','slow'],['soar','sore'],['soared','sword'],['solace','soulless'],['sole','soul'],['some','sum'],['son','sun'],['sonny','sunny'],['soot','suit'],['sordid','sorted'],['spade','spayed'],['spoor','spore'],['staid','stayed'],['stair','stare'],['stake','steak'],['statice','status'],['staph','staff'],['stationary','stationery'],['steal','steel'],['step','steppe'],['stile','style'],['stoop','stoup'],['straight','strait'],['succor','sucker'],['suede','swayed'],['suite','sweet'],['summary','summery'],['sundae','Sunday'],['tach','tack'],['tacks','tax'],['tail','tale'],['tailer','tailor'],['taper','tapir'],['tare','tear'],['taught','taut'],['tea','tee','ti'],['team','teem'],['teaming','teeming'],['tear','tier'],['teas','tease','tees'],['tenner','tenor'],['tense','tents'],['tern','terne','turn'],['thai','tie'],['their','there','they\'re'],['threw','through'],['throe','throw'],['throes','throws'],['throne','thrown'],['thyme','time'],['tic','tick'],['ticks','tics'],['tide','tied'],['tighten','titan'],['timber','timbre'],['tire','tyer'],['to','too','two'],['toad','toed','towed'],['tocsin','toxin'],['tocsins','toxins'],['toe','tow'],['told','tolled'],['tole','toll'],['tongue','tung'],['toon','tune'],['tort','torte'],['tough','tuff'],['tracked','tract'],['tray','trey'],['troop','troup'],['trooper','trouper'],['troopers','troupers'],['trussed','trust'],['vain','vane','vein'],['vale','veil'],['vary','very'],['verses','versus'],['vial','vile','viol'],['vice','vise'],['WACs','wax','whacks'],['wade','weighed'],['wail','wale','whale'],['wain','wane'],['waist','waste'],['wait','weight'],['waive','wave'],['waiver','waver'],['wales','whales','wails'],['walk','wok'],['walks','woks'],['want','wont'],['war','wore'],['ware','wear','where'],['warn','worn'],['warrantee','warranty'],['warship','worship'],['wary','wherry'],['way','weigh','whey'],['we','wee'],['we\'d','weed'],['we\'ll','wheel'],['we\'re','weir'],['were','whir'],['we\'ve','weave'],['weak','week'],['weal','wheel'],['weald','wheeled','wield'],['weather','wether','whether'],['weld','welled'],['wen','when'],['wet','whet'],['which','witch'],['whig','wig'],['while','wile'],['whiled','wild'],['whine','wine'],['whined','wind','wined'],['whirled','world'],['whirred','word'],['whit','wit'],['whither','wither'],['who\'s','whose'],['whoa','woe'],['why','wye'],['won\'t','wont'],['wood','would'],['worst','wurst'],['y\'all','yawl'],['yack','yak'],['yoke','yolk'],['yokes','yolks']['yore','you\'re','your']]
var homophone_list = [].concat.apply([], homophones)
//if(homophones.indexOf(word) !== -1) //find somehow