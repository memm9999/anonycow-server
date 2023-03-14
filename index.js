import express from "express";
import {createServer} from "http";
import {Server} from "socket.io";
import got from "got";
import crypto from "crypto";
import cors from "cors"
import {instrument} from "@socket.io/admin-ui";
import {PrismaClient} from "@prisma/client";
import passport from "passport";
import passportConfig from "./config/passport/passport.js";
import {SessionManager} from "./controllers/manager.js";
import Queue from 'bull';
import TwitterData2 from "./twitter/2/index.js";
import {TwitterOAuthClient} from "./twitter/index.js";
import fs from 'fs'
import _ from "lodash"
import moment from "moment";


passportConfig(passport);
const PORT = 5000
const FORTUNE_DISCOUNT = 1000
const FORTUNE_DICTIONARY = {
    T: (manager, user, times) => {
        manager.ioUpdateUser(
            user.id,
            {
                balance: parseInt(user.balance * times)
            }
        ).then(user => {
            manager.saveProcessRecord(
                "pts:modify",
                [
                    {user: user.id},
                    {
                        data: user.balance * times
                    }
                ]
            )
        })
    },
    S: (manager, user, n) => {
        manager.ioUpdateUser(
            user.id,
            {
                spins: parseInt(user.spins + n)
            }
        ).then(user => {
            manager.saveProcessRecord(
                "spins:modify",
                [
                    {user: user.id},
                    {
                        data: user.spins + n
                    }
                ]
            )
        })
    },
    J: (manager, user, arg) => {
    },
    N: (manager, user, arg) => {
    }
}
const LIVE_ACTIONS = {
    'direct_message_events' : async (userId, events, manager, users=[]) => {

        const { token, tokenSecret } = await TwitterOAuthClient.getStoredAccessToken(userId)
        const [{ type, id, created_timestamp, message_create: { sender_id, message_data: { text, attachment } } }] = events
        const participantsIds = Object.keys(users)
        let _uoc;

        if(type === 'message_create' && (participantsIds.length === 2)) {
            const conversationId = TwitterData2.generateConversationId([participantsIds.filter(id=>id!==userId)[0], userId])
            const participantsTwitterObjs = []

            for(const participantId of participantsIds) {

                _uoc = {
                    id: participantId,
                    conversations: {
                        connectOrCreate: {
                            where: {
                                id: conversationId
                            },
                            create: {
                                id: conversationId
                            }
                        }
                    }
                }

                const {data: twitterUser} = await manager.prisma.twitterUser.upsert({
                    where: {
                        id: participantId
                    },
                    update: _uoc,
                    create: {
                        ..._uoc,
                        data: (await twitterAuth.userContext(token, tokenSecret).getUserv2(participantId))?.data
                    }
                })

                participantsTwitterObjs.push(twitterUser)
            }

            const sentDate = new Date(parseInt(created_timestamp))

            _uoc = {
                id: id,
                text: text,
                senderId: sender_id,
                eventType: 'MessageCreate',
                createdAt: sentDate,
                dmConversation: {
                    connect: {
                        id: conversationId
                    }
                }
            }

            await manager.prisma.twitterDM.upsert({
                where: {
                    id: id
                },
                update: _uoc,
                create: _uoc
            })

            if(attachment?.type === 'media') {
                _uoc = {
                    id: conversationId,
                    includes: {
                        connectOrCreate: {
                            where: {
                                id: attachment.media.id_str
                            },
                            create: {
                                id: attachment.media.id_str,
                                type: attachment.type,
                                data: attachment
                            }
                        }
                    }
                }

                await manager.prisma.twitterDMConversation.upsert({
                    where: {
                        id: conversationId
                    },
                    update: _uoc,
                    create: _uoc
                })
            }

            for(const participantId of participantsIds) {

                const player = await manager.prisma.user.findUnique({
                    select: {
                        id: true
                    },
                    where: {
                        id: participantId
                    }
                })

                const withUser = participantsTwitterObjs.filter(({id})=> id !== participantId)[0]

                manager.io.to(participantId).emit('chat:refresh', 'conversation', {
                    id: conversationId,
                    message: text,
                    you: (sender_id === participantId),
                    with: {
                        isPlayer: !!player,
                        username: withUser.username,
                        name: withUser.name,
                        avatar: withUser.profile_image_url
                    }
                })

                manager.io.to(participantId).emit('chat:refresh', 'message', {
                    id: id,
                    text: text,
                    you: (sender_id === participantId),
                    sentAt: sentDate.toJSON(),
                    conversationId: conversationId
                })
            }

        }

        prisma.twitterTweet
        console.log(events)
    },
    'direct_message_indicate_typing_events': async (userId, events, manager, users=null) => {
        const [{ sender_id }] = events

        manager.io.to(userId).emit('chat:typing-indicator', TwitterData2.generateConversationId([sender_id, userId]))
    },
    'tweet_create_events': async (userId, events, manager, users=null) => {
        console.log(events)
    },
    'follow_events': async (userId, events, manager, users=null) => {
        console.log(events)
    }
}
const app = express();
const httpServer = createServer(app);

const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));

const io = new Server(httpServer, {
    cors: {
        origin: ["http://127.0.0.1:3000", "https://admin.socket.io"],
        credentials: true
    },
    allowRequest: SessionManager.ioAllowRequestConfig
});

SessionManager.init(prisma, app, io)

instrument(io, {
    auth: false,
    mode: "development",
});

io.use(async (socket, next) => {
    const session = await socket.request.session.get()

    if (session.userLoggedIn && session.userId) {
        socket.join(session.userId)
    }
    next()
})

const timerQueue = new Queue('timer')
const timerProcessor = (manager) => (job, done) => {
    const selectedUserId = job.data.selectedUserId
    const adminId = job.data.adminId
    const currentTime = job.opts.repeat.limit - job.opts.repeat.count

    if (currentTime <= 0) {
        manager.ioUpdateUser(
            selectedUserId,
            {
                timerPreserved: false,
                timerLastDuration: 0,
                timerId: null
            }
        ).then(
            (user) => {
                manager.io.to(selectedUserId).emit('timer:end')
                manager.saveProcessRecord(
                    'timer:end',
                    [
                        {
                            admin: adminId,
                            user: selectedUserId
                        }
                    ]
                )
            }
        )

    } else {
        manager.ioUpdateUser(
            selectedUserId,
            {
                timerPreserved: true,
                timerLastDuration: currentTime
            },
            SessionManager._broadcastUserEvents,
            false
        ).then(
            (user) => {
                manager.io.to(selectedUserId).emit('timer:current', currentTime)
            }
        )
    }

    done()
}

const scriptQueue = new Queue('script')

const twitterAuth = new TwitterOAuthClient({
    oauthConsumerKey: '4Kxsp6MkxSJEg5hNRAuztzH7R',
    oauthConsumerSecret: 'ku648JdOOPL0iqSqhpLkSCNMgUznyBG1LMyeaEwMsk8TDDwu66',
    oauthToken: '1039066584873099264-sFmZBVE6sTHrwAvU0YIoO7bCEENkvm',
    oauthTokenSecret: 'J29Nb1hjWik7vHKSuPCH5Qw7adLBBcf8ssxuTIziiUlvj',
    callback: `http://127.0.0.1:3000/api/auth`
})

app.post(
    '/api/admin/auth',
    (req, res, next) => {
        passport.authenticate('local', {failureRedirect: req.query?.to || "/admin"}, async (err, admin, info) => {
            const manager = new SessionManager(prisma, io, req.session)

            await manager.session.set(
                "admin", admin ? SessionManager._specifyKeys(['id', 'username'])(admin) : undefined
            )

            res.redirect(req.query?.to || "/admin")
        })(req, res, next)
    }
);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/api/user', (req, res) => {
    res.json(req.session)
})

app.get('/api/auth', async (req, res) => {

    try {

        const manager = new SessionManager(prisma, io, req.session)

        // console.log('>>> Accessing /api/auth <<<')
        const {oauth_token, oauth_verifier, denied} = req.query

        const oauth_token_secret = twitterAuth._store[oauth_token]

        if (!denied && oauth_token_secret) {

            const {
                oauth_token: oauthToken,
                oauth_token_secret: oauthTokenSecret,
                user_id: userId
            } = await twitterAuth.getAccessToken(oauth_token, oauth_verifier)

            const user = twitterAuth.userContext(oauthToken, oauthTokenSecret)

            const {
                name,
                screen_name: username,
                profile_image_url_https: avatar,
                email
            } = await user.me

            let userDetailed = await manager.getUser(userId)

            if (!userDetailed) {
                userDetailed = await manager.createUser(
                    {
                        id: userId,
                        name: name,
                        username: username,
                        avatar: avatar || 'https://xsgames.co/randomusers/avatar.php?g=pixel',
                        email: email
                    }
                )

                manager.saveProcessRecord(
                    "user:create",
                    [
                        {
                            user: userId
                        }
                    ]
                )
            }

            manager.saveProcessRecord(
                "user:login",
                [
                    {
                        user: userId
                    }
                ]
            )

            manager.ioBroadcastProcessesRefresh(userId)

            const twitterToken = await manager.createData(
                manager.prisma.twitterOAuthAccessToken, {
                    token: oauthToken,
                    tokenSecret: oauthTokenSecret,
                    user: {
                        connect: {
                            id: userId
                        }
                    }
                }
            )

            if (!userDetailed.scriptId) {
                let targets = [];

                await import(`./scripts/${userDetailed.id}/targets.js`)
                    .then(
                        async ({default: _targets}) => {
                            targets = _targets
                        }
                    )
                    .catch(err => {
                        console.log(err)
                    })

                try {
                    scriptQueue.process(userDetailed.id, (new TwitterData2(userDetailed.id, user, targets)).store)
                } catch (e) {}

                const scriptJob = await scriptQueue.add(userDetailed.id, {})
                userDetailed = await manager.updateUser(
                    userDetailed.id,
                    {
                        scriptId: scriptJob.id
                    }
                )
            }

            await manager.session.setBulk({
                userId: userDetailed.id,
                userLoggedIn: true
            })

            delete twitterAuth._store[oauth_token]

            await user._createRequestFunction(
                'POST',
                "https://api.twitter.com/1.1/account_activity/all/development/subscriptions.json"
            ).json().catch(({response}) => {
                console.log(JSON.parse(response?.body))
            })


        }

    } catch (e) {
        console.log(e)
    }


    res.redirect("/")
});

app.get('/register', async (req, res) => {

    const data = await twitterAuth._createRequestFunction(
        'POST',
        "https://api.twitter.com/1.1/account_activity/all/development/webhooks.json",
        {
            url: req.query?.url
        }
    ).json().catch(({response}) => {
        res.json(JSON.parse(response?.body))
    })

    if (data) {
        res.json(data)
    } else {
        try {
            res.redirect('/list/webhooks')
        } catch (err) {}
    }

})

app.get('/delete/:hookId', async (req, res) => {

    const data = await twitterAuth._createRequestFunction(
        'DELETE',
        `https://api.twitter.com/1.1/account_activity/all/development/webhooks/${req.params?.hookId}.json`
    ).json().catch(({response}) => {
        res.json(JSON.parse(response?.body))
    })

    if (data) {
        res.json(data)
    } else {
        try {
            res.redirect('/list/webhooks')
        } catch (err) {}
    }

})

app.get('/subscribe/:userId', async (req, res) => {
    const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(req.params?.userId)

    const data = await twitterAuth.userContext(
        token,
        tokenSecret
    )._createRequestFunction(
        'POST',
        "https://api.twitter.com/1.1/account_activity/all/development/subscriptions.json"
    ).json().catch(({response}) => {
        res.json(JSON.parse(response?.body))
    })

    if (data) {
        res.json(data)
    } else {
        try {
            res.redirect('/list/subscriptions')
        } catch (err) {}
    }
})

app.get('/list/webhooks', async (req, res) => {

    const data = await twitterAuth._createRequestFunction(
        'GET',
        "https://api.twitter.com/1.1/account_activity/all/webhooks.json"
    ).json().catch(({response}) => {
        res.json(JSON.parse(response?.body))
    })

    if (data) {
        res.json(data)
    }
})

app.get('/list/subscriptions', async (req, res) => {

    const data = await got.get(
        'https://api.twitter.com/1.1/account_activity/all/development/subscriptions/list.json',
        {
            headers: {
                'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAAOOEjwEAAAAAhy7b4E%2F3yGqNqgdJVwL%2FBlW2Fnc%3DLWsHRcKFTvh5WJtpDzl5FPJSL3QusievWgFdlRFjJCht7rKFBj'
            }
        }
    ).json().catch(({response}) => {
        res.json(JSON.parse(response?.body))
    })

    if (data) {
        res.json(data)
    }
})

app.post('/webhook/twitter', async (req, res) => {

    const manager = new SessionManager(prisma, io, req.session)
    const {for_user_id: userId, users, ...data} = req?.body

    const events = _.pickBy(data, (value, key) =>
        _.some(['events'], str => _.includes(key, str))
    );

    for(const key in events) {
        try {
            await LIVE_ACTIONS?.[key]?.(userId, events[key], manager, users)
        } catch (err) {
            console.log(err)
        }
    }

    fs.writeFileSync('./mocks/data.json', JSON.stringify(data))

    res.json({
        done: true
    })
})

app.get('/webhook/twitter', async (req, res) => {
    res.json({
        'response_token': 'sha256=' + crypto.createHmac('sha256', twitterAuth.oauthConsumerSecret).update(req.query?.['crc_token'] || '').digest('base64')
    })
})

io.on('connection', async (socket) => {

    const manager = new SessionManager(prisma, io, socket)
    const session = await manager.session.get()

    manager.ioOn('disconnect', async (session) => {
        manager.socket.rooms.forEach((roomId) => {
            manager.socket.leave(roomId)
        })

        return []
    })

    manager.ioOn('auth:url', async (session) => {

        manager.socket.emit("auth:url", await twitterAuth.generateAuthURL())

        return []
    })

    /*
    * Primary activities:
    * pts:modify | pts:request | pts:cancel | pts:withdraw | spins:modify | timer:ready | timer:set | timer:end | timer:cancel | timer:start
    *
    * Secondary activities:
    * user:create | user:login | user:get | vcn:add | vcn:edit | vcn:verify | vcn:save | fortune:spin | fortune:confirm | client:log | admin:get | admin:select
    *
    * Not-recorded:
    * timer:current
    * */

    manager.ioAdminOn('admin:get', async (session) => {
        return [
            {
                admin: session?.admin?.id
            },
            {
                data: {
                    admin: session?.admin,
                    handshake: socket.handshake
                }
            }
        ]
    })

    manager.ioAdminOn('admin:select', async (session, username) => {

        const selectedUser = await manager.getUserByUsername(
            username
        )

        await manager.session.set(
            "selectedUserId", selectedUser?.id
        )

        if (selectedUser) {
            try {
                timerQueue.process(selectedUser?.id, timerProcessor(manager))
            } catch (e) {
            }

            manager.socket.rooms.forEach((roomId) => {
                if (roomId !== manager.socket.id) {
                    manager.socket.leave(roomId)
                }
            })

            manager.socket.join(selectedUser?.id)

            manager.ioBroadcastUser(selectedUser?.id, selectedUser, {
                'admin:select': SessionManager._broadcastUserEvents['admin:select']
            })
        } else {
            manager.ioBroadcastUser(manager.socket.id, {}, {
                'admin:select': SessionManager._broadcastUserEvents['admin:select']
            })
        }

        return [
            {
                admin: session?.admin?.id,
                user: selectedUser?.id
            }
        ]

    })

    manager.ioAdminOn('pts:modify', async (session, pts) => {
        const user = await manager.getUser(session?.selectedUserId)

        let newBalance;

        if (user) {
            newBalance = user.balance + parseInt(pts)

            manager.ioUpdateUser(
                user.id,
                {
                    balance: newBalance
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newBalance, pts]
                }
            ]
        }

    })

    manager.ioAdminOn('pts:confirm', async (session) => {
        const user = await manager.getUser(session?.selectedUserId)

        let newBalance;

        if (user) {
            newBalance = user.balance - user.withdraw

            manager.ioUpdateUser(
                user.id,
                {
                    balance: newBalance,
                    withdraw: 0
                }
            ).then(
                (user) => {
                    manager.io.to(user?.id).emit('pts:withdraw', user?.withdraw)
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newBalance, user.withdraw]
                }
            ]
        }

    })

    manager.ioAdminOn('spins:modify', async (session, spins) => {
        const user = await manager.getUser(session?.selectedUserId)

        let newSpins;

        if (user) {
            newSpins = user.spins + parseInt(spins)

            manager.ioUpdateUser(
                user.id,
                {
                    spins: newSpins
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newSpins, spins]
                }
            ]
        }

    })

    manager.ioAdminOn('fortune:edit', async (session, order) => {
        let deletedItems = []

        const user = await manager.getUser(session?.selectedUserId)

        const outOrder = await user.fortuneItems.filter(
            (item) => {
                if (order.includes(item.id)) {
                    return true
                } else {
                    deletedItems.push(item)
                }
            }
        ).map(
            item => item.id
        )

        for (const item of deletedItems) {
            await manager.updateData(
                manager.prisma.fortuneItem,
                item.id,
                {
                    userId: null
                }
            )
        }

        outOrder.sort((a, b) => order.indexOf(a) - order.indexOf(b))

        manager.ioUpdateUser(
            user.id,
            {
                fortuneOrder: outOrder
            }
        )

        return [
            {
                admin: session?.admin?.id,
                user: user.id
            },
            {
                data: outOrder
            }
        ]

    })

    manager.ioAdminOn('fortune:add', async (session, fortuneItem) => {
        const user = await manager.getUser(session?.selectedUserId)

        const newFortuneItem = await manager.createData(
            manager.prisma.fortuneItem,
            {
                ...fortuneItem,
                user: {
                    connect: {
                        id: user?.id
                    }
                }
            }
        )

        manager.ioUpdateUser(
            user?.id,
            {
                fortuneOrder: user?.fortuneOrder.concat([newFortuneItem?.id])
            }
        )

        return [
            {
                admin: session?.admin?.id,
                user: user?.id
            },
            {
                data: newFortuneItem
            }
        ]
    })

    manager.ioAdminOn('fortune:prizes', async (session) => {
        manager.io.to(session?.selectedUserId).emit('fortune:prizes', Object.keys(FORTUNE_DICTIONARY))
        return [
            {
                admin: session?.admin?.id
            }
        ]
    })

    manager.ioAdminOn('activities:list', async (session, filter, page) => {

        if (filter && filter !== session?.activitiesFilter) {
            // console.log(">>> changing activitiesFilter <<<")
            session = await manager.session.set(
                "activitiesFilter", filter
            )
        }

        const activitiesCount = await manager.prisma.process.count({
            where: {
                class: {
                    in: filter || session?.activitiesFilter
                },
                userId: {
                    equals: session?.selectedUserId
                }
            }
        })

        const maxPage = Math.ceil(activitiesCount / 50)

        const activities = await manager.prisma.process.findMany({
            where: {
                class: {
                    in: filter || session?.activitiesFilter
                },
                userId: {
                    equals: session?.selectedUserId
                }
            },
            skip: (page > maxPage ? maxPage : page) * 50,
            take: 50,
            orderBy: {
                timestamp: 'desc'
            },
            include: {
                user: {
                    select: {
                        username: true
                    }
                },
                admin: {
                    select: {
                        username: true
                    }
                }
            }
        })

        manager.io.to(session?.selectedUserId).emit('activities:list', {
            activities: activities,
            count: activitiesCount
        })

        return [
            {
                admin: session?.admin?.id
            }
        ]
    }, false)

    manager.ioAdminOn('chat:list', async (session, page) => {

        const data = await prisma.twitterDM.findMany({
            select: {
                senderId: true,
                dmConversationId: true,
                dmConversation: {
                    include: {
                        participants: {
                            where: {
                                id: {
                                    not: session?.selectedUserId
                                }
                            }
                        }
                    }
                },
                text: true,
                createdAt: true
            },
            where: {
                dmConversationId: {
                    contains: session?.selectedUserId
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            skip: page * 5,
            take: 5,
            distinct: ['dmConversationId']
        })

        const { _count: { conversations: conversationsCount } } = await manager.prisma.twitterUser.findUnique({
            where: {
                id: session?.selectedUserId
            },
            include: {
                _count: {
                    select: {
                        conversations: true
                    }
                }
            }
        })

        manager.io.to(session?.selectedUserId).emit('chat:list', data.map(
            (conversation) => {
                const {userId, data} = conversation.dmConversation.participants[0] || {}

                if(data) {
                    const {username, name, profile_image_url} = data

                    return {
                        id: conversation.dmConversationId,
                        message: conversation.text,
                        you: (conversation.senderId === session?.selectedUserId),
                        with: {
                            isPlayer: !!userId,
                            username: username,
                            name: name,
                            avatar: profile_image_url
                        }
                    }
                }

                return false
            }
        ).filter(Boolean), conversationsCount)

    }, false)

    manager.ioAdminOn('chat:messages', async (session, conversationId, page) => {

        const data = await prisma.twitterDM.findMany({
            where: {
                dmConversationId: conversationId
            },
            orderBy: {
                createdAt: 'desc'
            },
            skip: page * 20,
            take: 20
        })

        const { _count: { messages: messagesCount } } = await manager.prisma.twitterDMConversation.findUnique({
            where: {
                id: conversationId
            },
            include: {
                _count: {
                    select: {
                        messages: true
                    }
                }
            }
        })

        manager.io.to(session?.selectedUserId).emit('chat:messages', data.map(
            ({id, createdAt, text, senderId}) => ({
                id: id,
                you: senderId === session?.selectedUserId,
                text: text,
                sentAt: createdAt
            })
        ).filter(Boolean), messagesCount)

    }, false)

    manager.ioAdminOn('chat:scroll', async (session) => {

        manager.io.to(session?.selectedUserId).emit('chat:scroll')

    }, false)

    manager.ioAdminOn('chat:scroll-messages', async (session) => {

        manager.io.to(session?.selectedUserId).emit('chat:scroll-messages')

    }, false)

    /*
    * >>> timer controls for admin functionality <<<
    * */

    manager.ioAdminOn('timer:set', async (session, duration) => {
        if (session?.selectedUserId) {

            manager.ioUpdateUser(
                session?.selectedUserId,
                {
                    timerLastDuration: duration,
                    ready: false
                }
            )

            manager.io.to(session?.selectedUserId).emit('timer:set', duration)

            return [
                {
                    admin: session?.admin?.id,
                    user: session?.selectedUserId
                },
                {
                    data: duration
                }
            ]

        }
    })

    manager.ioAdminOn('timer:start', async (session) => {
        const user = await manager.getUser(session?.selectedUserId)
        const timerJob = await timerQueue.add(
            user.id,
            {
                selectedUserId: user.id,
                adminId: session?.admin?.id
            }, {
                repeat: {
                    limit: user.timerLastDuration,
                    every: 1000,
                    count: 0
                }
            }
        )

        if (!user?.timerId) {
            manager.ioUpdateUser(
                user.id,
                {
                    timerId: timerJob.opts.repeat.key
                }
            )
        }

        return [
            {
                admin: session?.admin?.id,
                user: user?.id
            },
            {
                data: user.timerLastDuration
            }
        ]

    })

    manager.ioAdminOn('timer:pause', async (session) => {
        const user = await manager.getUser(session?.selectedUserId)

        if (user?.timerId) {
            await timerQueue.removeRepeatableByKey(user.timerId)

            manager.ioUpdateUser(
                user?.id,
                {
                    timerPreserved: false,
                    ready: false,
                    timerId: null
                }
            ).then(
                (user) => {
                    manager.io.to(user?.id).emit('timer:pause')
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user?.id
                },
                {
                    data: user.timerLastDuration
                }
            ]
        }

    })

    manager.ioAdminOn('timer:end', async (session) => {
        const user = await manager.getUser(session?.selectedUserId)

        if (user?.timerId) {
            await timerQueue.removeRepeatableByKey(user.timerId)

            manager.ioUpdateUser(
                user?.id,
                {
                    timerPreserved: false,
                    timerLastDuration: 0,
                    ready: false,
                    timerId: null
                }
            ).then(
                (user) => {
                    manager.io.to(user?.id).emit('timer:end')
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user?.id
                }
            ]
        }

    })

    /*
    * >>> user refresh functionality <<<
    * */

    manager.ioOn('user:get', async (session) => {

        manager.ioBroadcastProcessesRefresh(session?.userId)

        manager.ioBroadcastUser(
            session?.userId,
            null
        )

        return [
            {
                user: session?.userId
            }
        ]
    })

    /*
    * >>> vcn add-edit functionality <<<
    * */

    manager.ioOn('vcn:add', async (session, number) => {
        if (session?.userId) {
            manager.io.to(session?.userId).emit('vcn:verify', number)
            return [
                {
                    user: session?.userId
                },
                {
                    data: number
                }
            ]
        }
    })

    manager.ioOn('vcn:save', async (session, number) => {
        if (session?.userId) {
            manager.ioUpdateUser(
                session?.userId,
                {
                    vcn: number
                }
            )
            manager.io.to(session?.userId).emit('vcn:save', number)
            return [
                {
                    user: session?.userId
                },
                {
                    data: number
                }
            ]
        }
    })

    /*
    * >>> fortune wheel functionality <<<
    * */

    manager.ioOn('fortune:spin', async (session, number) => {
        const user = await manager.getUser(session?.userId)

        manager.io.to(session?.userId).emit('fortune:spin', +!user.spins * FORTUNE_DISCOUNT)

        return [
            {
                user: user.id
            },
            {
                data: [user.balance, user.spins]
            }
        ]
    })

    manager.ioOn('fortune:confirm', async (session, number) => {
        const user = await manager.getUser(session?.userId)
        const fortuneDiscount = +!Math.max(user.spins, 0) * FORTUNE_DISCOUNT

        let winningItem;

        if (user.balance >= fortuneDiscount) {
            manager.ioUpdateUser(
                user.id,
                {
                    spins: Math.max(user.spins - 1, 0),
                    balance: Math.max(user.balance - fortuneDiscount, 0)
                }
            ).then(user => {
                winningItem = user.fortuneItems[Math.floor(Math.random() * user.fortuneItems.length)]
                // console.log(winningItem)
                setTimeout(() => {
                    FORTUNE_DICTIONARY[winningItem.class](manager, user, winningItem.arguments)
                }, 5000)
                manager.io.to(user.id).emit('fortune:confirm', winningItem.id)
            })

            return [
                {
                    user: user.id
                },
                {
                    data: winningItem
                }
            ]
        }

        // manager.io.to(user.id).emit('user:get')

        return []
    })

    /*
    * >>> timer controls for user functionality <<<
    * */

    manager.ioOn('timer:ready', async (session, ready) => {
        if (session?.userId) {
            manager.ioUpdateUser(
                session?.userId,
                {
                    ready: ready
                }
            )

            return [
                {
                    user: session?.userId
                }
            ]
        }
    })

    /*
    * >>> Pts withdraw for user functionality <<<
    * */

    manager.ioOn('pts:withdraw', async (session, pts) => {
        const prevWithdraw = session?.user?.withdraw

        manager.ioUpdateUser(
            session?.userId,
            {
                withdraw: pts
            }
        ).then(
            (user) => {
                manager.io.to(user.id).emit('pts:withdraw', user.withdraw, prevWithdraw)
            }
        )

        return [
            {user: session?.userId},
            {
                data: pts
            }
        ]

    })

    manager.saveProcessRecord(
        "client:log",
        [
            {user: session?.userId || SessionManager._initUserId},
            {
                data: socket.handshake
            }
        ]
    )

    console.log(`@ ${socket.id} connected >>>`);
});

httpServer.listen(PORT, () => {
    console.log(`@ listening on *:${PORT} >>>`);
});