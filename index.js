import express from "express";
import {createServer} from "http";
import {Server} from "socket.io";
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
import _ from "lodash"
import {createProxyMiddleware} from "http-proxy-middleware"
import FORTUNE_DICTIONARY from "./config/settings/fortune/dictionary.js"
import {resolve} from "path"

passportConfig(passport);

const TWITTER_WEBHOOKS_REGISTERATION_URL_PATHNAME = (new URL(process.env.TWITTER_WEBHOOKS_REGISTERATION_URL)).pathname
const LIVE_ACTIONS = {
    'direct_message_events': async (userId, events, manager, users = []) => {

        const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(userId)
        const userContext = twitterAuth.userContext(token, tokenSecret)
        const twitterData = new TwitterData2(userId, userContext)
        const [{type, id, created_timestamp, message_create: {sender_id, message_data: {text, attachment}}}] = events
        const sentDate = new Date(parseInt(created_timestamp))
        const participantsIds = Object.keys(users)
        const subscribedUser = users[userId]
        const senderUser = users[sender_id]

        let _uoc;

        if (type === 'message_create' && (participantsIds.length === 2)) {
            manager.sendNotification(
                userId + '-admin',
                {
                    title: `@${subscribedUser.screen_name} have a new chat`,
                    body: `@${senderUser.screen_name}: ${text}`,
                    image: subscribedUser.profile_image_url.replace('_normal', '')
                }
            )

            const conversationId = TwitterData2.generateConversationId([participantsIds.filter(id => id !== userId)[0], userId])

            const participantsTwitterObjs = []

            for (const participantId of participantsIds) {

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
                    create: _uoc
                })

                if (!twitterUser) {
                    await manager.prisma.twitterUser.update({
                        where: {
                            id: participantId
                        },
                        data: {
                            data: (await userContext.getUserv2(participantId))?.data
                        }
                    })
                }

                const withUser = participantsTwitterObjs.filter(({id}) => id !== participantId)[0]

                participantsTwitterObjs.push(twitterUser)
            }

            for (const participantId of participantsIds) {

                const player = await manager.prisma.user.findUnique({
                    select: {
                        id: true
                    },
                    where: {
                        id: participantId
                    }
                })

                const withUser = participantsTwitterObjs.filter(({id}) => id !== participantId)[0]

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

            await twitterData.refreshPollConversation(participantsIds)

        }
    },
    'direct_message_indicate_typing_events': async (userId, events, manager, users = []) => {
        const [{sender_id}] = events
        const subscribedUser = users[userId]
        const senderUser = users[sender_id]

        manager.sendNotification(
            userId + '-admin',
            {
                title: `@${senderUser.screen_name} is typing to @${subscribedUser.screen_name}`,
                image: subscribedUser.profile_image_url.replace('_normal', '')
            }
        )
        manager.io.to(userId).emit('chat:typing-indicator', TwitterData2.generateConversationId([sender_id, userId]))
    },
    'tweet_create_events': async (userId, events, manager, users = null) => {
        const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(userId)
        const userContext = twitterAuth.userContext(token, tokenSecret)
        const twitterData = new TwitterData2(userId, userContext)
        const [{id_str: tweetId, created_at, text, entities: {user_mentions}, user: {id_str: authorId, screen_name, profile_image_url}}] = events

        manager.sendNotification(
            userId + '-admin',
            {
                title: `@${screen_name} have just tweeted`,
                body: text,
                image: profile_image_url.replace('_normal', '')
            }
        )

        const _uoc = {
            id: authorId,
            tweets: {
                connectOrCreate: {
                    where: {
                        id: tweetId
                    },
                    create: {
                        id: tweetId,
                        text: text,
                        createdAt: new Date(created_at),
                        data: events[0]
                    }
                }
            }
        }

        await manager.prisma.twitterUser.upsert({
            where: {
                id: authorId
            },
            update: _uoc,
            create: _uoc
        })

        for (const {id_str: mentionedUserId} of user_mentions) {
            const _uoc = {
                id: mentionedUserId,
                mentions: {
                    connect: {
                        id: tweetId
                    }
                }
            }

            await manager.prisma.twitterUser.upsert({
                where: {
                    id: mentionedUserId
                },
                update: _uoc,
                create: _uoc
            })
        }

        await TwitterOAuthClient.sleep(30000)

        await twitterData.refreshPollTweets()
    },
    'favorite_events': async (userId, events, manager, users = null) => {
        const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(userId)
        const userContext = twitterAuth.userContext(token, tokenSecret)
        const twitterData = new TwitterData2(userId, userContext)

        await TwitterOAuthClient.sleep(30000)

        await twitterData.refreshPollTweets()
    },
    'follow_events': async (userId, events, manager, users = null) => {
        const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(userId)
        const [{type, source: {id: sourceId, screen_name: sourceUsername}, target: {id: targetId, screen_name: targetUsername}}] = events
        const userContext = twitterAuth.userContext(token, tokenSecret)
        const twitterData = new TwitterData2(userId, userContext)

        manager.sendNotification(
            userId + '-admin',
            {
                title: `@${sourceUsername} ${type}-actioned @${targetUsername}`
            }
        )

        switch (type) {
            case 'follow':
                const newFollows = await twitterData.refreshPollFollows()

                if (!(newFollows.includes(targetId))) {
                    const [{connections}] = await userContext.makeAPIRequest(
                        'GET',
                        'https://api.twitter.com/1.1/friendships/lookup.json',
                        {
                            'user_id': targetId === userId ? sourceId : targetId
                        }
                    )

                    if (!(connections.includes('following_requested') || connections.includes('following_received')) && connections) {
                        await twitterData.storeFollow(sourceId, targetId)
                    }

                }
                break

            case 'unfollow':
                await twitterData.removeFollow(sourceId, targetId)
                break

            default:
                break
        }

    }
}
const app = express();
const httpServer = createServer(app);


const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.use(express.static(resolve('./client/build')));

const io = new Server(httpServer, {
    cors: {
        origin: [process.env.APP_ORIGIN, "https://admin.socket.io"],
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
const timerProcessor = (manager) => (
    {
        data: {
            selectedUserId,
            adminId,
            warningTime
        },
        opts: {
            repeat: {
                limit,
                count
            }
        }
    }, done
) => {
    // const selectedUserId = job.data.selectedUserId
    // const adminId = job.data.adminId
    const currentTime = limit - count

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

        manager.sendNotification(
            selectedUserId,
            {
                title: `The mission is done`,
                body: `Wait for the new mission`
            }
        )

    } else {
        if(currentTime === Math.ceil(warningTime)) {
            manager.sendNotification(
                selectedUserId,
                {
                    title: `The mission will end soon ...`,
                    body: `A quarter of the time has passed`
                }
            )
        }

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
    oauthConsumerKey: process.env.TWITTER_OAUTH_CONSUMER_KEY,
    oauthConsumerSecret: process.env.TWITTER_OAUTH_CONSUMER_SECRET,
    oauthToken: process.env.TWITTER_OAUTH_TOKEN,
    oauthTokenSecret: process.env.TWITTER_OAUTH_TOKEN_SECRET,
    callback: process.env.TWITTER_CALLBACK
})

app.post(
    '/api/admin/auth',
    (req, res, next) => {
        passport.authenticate('local', {failureRedirect: req.query?.to || "/admin"}, async (err, admin, info) => {
            const manager = new SessionManager(prisma, io, req.session)

            await manager.session.setBulk({
                admin: admin ? SessionManager._specifyKeys(['id', 'username'])(admin) : undefined,
                subscribings: []
            })

            if(req.query?.to?.includes('prisma-studio')) {
                res.redirect("/prisma-studio")
            } else {
                res.redirect(req.query?.to || "/admin")
            }

        })(req, res, next)
    }
);

app.use(
    '/prisma-studio/assets/prisma-studio/vendor.js',
    createProxyMiddleware(
        {
            target: process.env.PRISMA_STUDIO_ORIGIN,
            changeOrigin: true,
            pathRewrite: {
                '^/prisma-studio/assets/prisma-studio/vendor.js' : '/assets/vendor.js'
            },
            onProxyReq: async (proxyReq, req, res) => {
                const session = await req?.session?.get()

                if (!session?.admin?.id) {
                    res.redirect("/admin/prisma-studio")
                }

            }
        }
    )
)

app.use(
    '/prisma-studio/api',
    createProxyMiddleware(
        {
            target: process.env.PRISMA_STUDIO_ORIGIN,
            changeOrigin: true,
            pathRewrite: {
                '^/prisma-studio/api' : '/api'
            },
            onProxyReq: async (proxyReq, req, res) => {
                const session = await req?.session?.get()

                if (!session?.admin?.id) {
                    res.redirect("/admin/prisma-studio")
                }

            }
        }
    )
)

app.use(
    createProxyMiddleware(
        ['/prisma-studio/**'],
        {
            target: process.env.PRISMA_STUDIO_ORIGIN,
            changeOrigin: true,
            pathRewrite: {
                '^/prisma-studio' : '/'
            },
            onProxyReq: async (proxyReq, req, res) => {
                const session = await req?.session?.get()

                if (!session?.admin?.id) {
                    res.redirect("/admin/prisma-studio")
                }

            },
            onProxyRes: (proxyRes, req, res) => {
                delete proxyRes.headers['content-length']
                const _write = res.write;

                res.write = function (data) {
                    try{
                        data = data.toString()
                        data = data.replaceAll(new RegExp('(?<!\\.|\\/)\\.\\/', 'gm'), './prisma-studio/')
                        data = data.replaceAll('/api', '/prisma-studio/api')
                        const buf = Buffer.from(data, 'utf-8');
                        _write.call(res,buf);
                    } catch (err) {
                        console.log(err);
                    }
                }
            }
        }
    )
)

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
                        avatar: avatar || process.env.TWITTER_USER_ALTERNATIVE_AVATAR,
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

            if (!userDetailed.scriptId && !userDetailed.scripted) {
                let targets = [];

                await import(`./config/settings/store/${userDetailed.id}/targets.js`)
                    .then(
                        async ({default: _targets}) => {
                            targets = _targets
                        }
                    )
                    .catch(err => {
                        console.log(err)
                    })

                try {
                    scriptQueue.process(userDetailed.id, async (job, done) =>{
                        await (new TwitterData2(userDetailed.id, user, targets)).store(job, done)
                        await manager.updateUser(
                            userDetailed.id,
                            {
                                scriptId: null
                            }
                        )
                        manager.io.to(userDetailed.id).emit('user:restore-status', false)
                    })
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

            await user.makeAPIRequest(
                'POST',
                "https://api.twitter.com/1.1/account_activity/all/development/subscriptions.json"
            )


        }

    } catch (e) {
        console.log(e)
    }


    res.redirect("/")
});

app.post(TWITTER_WEBHOOKS_REGISTERATION_URL_PATHNAME, async (req, res) => {

    const manager = new SessionManager(prisma, io, req.session)
    const {for_user_id: userId, users, ...data} = req?.body

    const events = _.pickBy(data, (value, key) =>
        _.some(['events'], str => _.includes(key, str))
    );

    for (const key in events) {
        try {
            await LIVE_ACTIONS?.[key]?.(userId, events[key], manager, users)
        } catch (err) {
            console.log(err)
        }
    }

    res.json({
        done: true
    })
})

app.get(TWITTER_WEBHOOKS_REGISTERATION_URL_PATHNAME, async (req, res) => {
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

        pts = parseInt(pts)

        let newBalance;

        if (user) {
            newBalance = user.balance + pts

            manager.ioUpdateUser(
                user.id,
                {
                    balance: newBalance
                }
            )

            manager.io.to(user.id).emit('pts:modify', pts, newBalance)

            manager.sendNotification(
                user.id,
                {
                    title: pts > 0 ? `You just received ${pts} Pts` : pts < 0 ? `Oh! ${Math.abs(pts)} Pts have been deducted from your balance` : `Balance reminder!`,
                    body: `Your current Pts balance is ${newBalance}`
                }
            )

            return [
                {
                    admin: session?.admin?.id,
                    user: user?.id
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
                    manager.sendNotification(
                        user.id,
                        {
                            title: `Withdrawal confirmed`,
                            body: `Please check your vodafone cash wallet`
                        }
                    )
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

        spins = parseInt(spins)

        let newSpins;

        if (user) {
            newSpins = user.spins + spins

            manager.ioUpdateUser(
                user.id,
                {
                    spins: newSpins
                }
            )

            manager.io.to(user?.id).emit('spins:modify', spins, newSpins)

            switch (true) {
                case spins > 0:
                    manager.sendNotification(
                        user.id,
                        {
                            title: `Congrats! You can spin your lucky wheel for x${newSpins} for free`,
                            body: `Don't waste your tries`
                        }
                    )
                    break

                case spins < 0:
                    manager.sendNotification(
                        user.id,
                        {
                            title: `An update about your lucky wheel`,
                            body: `Oh! Your tries to spin became x${newSpins}`
                        }
                    )
                    break

                default:
                    break
            }

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

        manager.io.to(user?.id).emit('fortune:add', newFortuneItem)

        manager.sendNotification(
            user.id,
            {
                title: `A new item has been added to your lucky wheel`,
                body: `The item is "${newFortuneItem?.title}"`
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

        manager.io.to(manager.socket.id).emit('activities:list', {
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

        const {_count: {conversations: conversationsCount}} = await manager.prisma.twitterUser.findUnique({
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

        manager.io.to(manager.socket.id).emit('chat:list', data.map(
            (conversation) => {
                const {userId, id, data} = conversation.dmConversation.participants[0] || {}

                if (data) {
                    const {username, name, profile_image_url} = data

                    return {
                        id: conversation.dmConversationId,
                        message: conversation.text,
                        you: (conversation.senderId === session?.selectedUserId),
                        with: {
                            isPlayer: !!userId,
                            id: id,
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

        const {_count: {messages: messagesCount}} = await manager.prisma.twitterDMConversation.findUnique({
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

        manager.io.to(manager.socket.id).emit('chat:messages', data.map(
            ({id, createdAt, text, senderId}) => ({
                id: id,
                you: senderId === session?.selectedUserId,
                text: text,
                sentAt: createdAt
            })
        ).filter(Boolean), messagesCount)

    }, false)

    manager.ioAdminOn('chat:scroll', async (session) => {

        manager.io.to(manager.socket.id).emit('chat:scroll')

    }, false)

    manager.ioAdminOn('chat:scroll-messages', async (session) => {

        manager.io.to(manager.socket.id).emit('chat:scroll-messages')

    }, false)

    manager.ioAdminOn('user:restore', async (session) => {

        const twitterUser = await manager.prisma.twitterUser.findUnique({
            where: {
                id: session?.selectedUserId
            }
        })

        const user = await manager.getUser(session?.selectedUserId)

        const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(session?.selectedUserId)
        const userContext = twitterAuth.userContext(token, tokenSecret)

        if(!user?.scriptId) {
            try {
                scriptQueue.process(session?.admin?.id+session?.selectedUserId, async (job, done) =>{
                    manager.io.to(session?.selectedUserId).emit('user:restore-status', true)
                    await (new TwitterData2(session?.selectedUserId, userContext, twitterUser.targets, true)).store(job, done)
                    await manager.updateUser(
                        session?.selectedUserId,
                        {
                            scriptId: null
                        }
                    )
                    manager.io.to(session?.selectedUserId).emit('user:restore-status', false)
                })
            } catch (e) {
            }

            const scriptJob = await scriptQueue.add(session?.admin?.id+session?.selectedUserId, {})
            await manager.updateUser(
                session?.selectedUserId,
                {
                    scriptId: scriptJob.id
                }
            )
        }

    }, false)

    manager.ioAdminOn('user:restore-status', async (session) => {
        const user = await manager.getUser(session?.selectedUserId)

        manager.io.to(user?.id).emit('user:restore-status', !!user?.scriptId)
    }, false)

    manager.ioAdminOn('notify:join', async (session) => {

        for await (const userId of session?.subscribings) {
            await manager.firebaseMessaging.subscribeToTopic(session?.fcmToken, userId + '-admin').then(response=>{
                // console.log(response)
            }).catch(err=>{
                console.log(err)
            })
        }

    }, false)

    manager.ioAdminOn('notify:subscribe', async (session) => {

        if(session?.fcmToken && session?.selectedUserId) {
            await manager.socket.request.session.set("subscribings", _.uniqWith(session?.subscribings?.concat([session?.selectedUserId]), _.isEqual))
            manager.io.to(manager.socket.id).emit('notify:list', (await manager.socket.request.session.get()).subscribings)
            await manager.firebaseMessaging.subscribeToTopic(session?.fcmToken, session?.selectedUserId + '-admin').then(response=>{
                // console.log(response)
            }).catch(err=>{
                console.log(err)
            })
        }

    }, false)

    manager.ioAdminOn('notify:unsubscribe', async (session) => {

        if(session?.fcmToken && session?.selectedUserId) {
            await manager.socket.request.session.set("subscribings", _.uniqWith(session?.subscribings?.filter(id=>id!==session?.selectedUserId), _.isEqual))
            manager.io.to(manager.socket.id).emit('notify:list', (await manager.socket.request.session.get()).subscribings)
            await manager.firebaseMessaging.unsubscribeFromTopic(session?.fcmToken, session?.selectedUserId + '-admin').then(response=>{
                // console.log(response)
            }).catch(err=>{
                console.log(err)
            })
        }

    }, false)

    manager.ioAdminOn('notify:list', async (session) => {

        manager.io.to(manager.socket.id).emit('notify:list', (await manager.socket.request.session.get()).subscribings)

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

            manager.sendNotification(
                session?.selectedUserId,
                {
                    title: `Are you ready for the new mission ?`,
                    body: `As soon as you are ready, press ready`
                }
            )

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

        if (!user?.timerId) {
            const timerJob = await timerQueue.add(
                user.id,
                {
                    selectedUserId: user.id,
                    warningTime: user.timerLastDuration * 0.25,
                    adminId: session?.admin?.id
                }, {
                    repeat: {
                        limit: user.timerLastDuration,
                        every: 1000,
                        count: 0
                    }
                }
            )

            manager.ioUpdateUser(
                user.id,
                {
                    timerId: timerJob.opts.repeat.key
                }
            )

            manager.sendNotification(
                session?.selectedUserId,
                {
                    title: `The mission started ...`,
                    body: `Good luck! :)`
                }
            )

            manager.io.to(user?.id).emit('timer:start')
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

            manager.sendNotification(
                session?.selectedUserId,
                {
                    title: `The mission paused :(`,
                    body: `As soon as you are ready, press ready`
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

            manager.sendNotification(
                session?.selectedUserId,
                {
                    title: `The mission is done`,
                    body: `Wait for the new mission`
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

        manager.io.to(session?.userId).emit('fortune:spin', +!user.spins * process.env.FORTUNE_DISCOUNT)

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
        const fortuneDiscount = +!Math.max(user.spins, 0) * process.env.FORTUNE_DISCOUNT

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
            ).then((user)=>{
                manager.io.to(session?.userId).emit('timer:ready', user.username, user.ready)
                if(ready) {
                    manager.sendNotification(
                        user.id + '-admin',
                        {
                            title: `@${user.username} is ready to start the mission`,
                            body: `You can start the mission now`,
                            image: user.avatar.replace('_normal', '')
                        }
                    )
                } else {
                    manager.sendNotification(
                        user.id + '-admin',
                        {
                            title: `@${user.username} changed their mind`,
                            body: `Wait for them to be ready`,
                            image: user.avatar.replace('_normal', '')
                        }
                    )
                }
            })

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
                manager.sendNotification(
                    user.id + '-admin',
                    {
                        title: user.withdraw ? `@${user.username} is requesting ${user.withdraw} Pts` : `@${user.username} cancelled the withdrawal operation`,
                        image: user.avatar.replace('_normal', '')
                    }
                )
            }
        )

        return [
            {user: session?.userId},
            {
                data: pts
            }
        ]

    })

    manager.ioOn('fcm:store', async (session, token) => {
        await manager.session.set(
            'fcmToken', token
        )
    })

    manager.ioOn('fcm:subscribe', async (session) => {
        if(session?.fcmToken && session?.userId) {
            await manager.firebaseMessaging.subscribeToTopic(session?.fcmToken, session?.userId).then(response=>{
                // console.log(response)
            }).catch(err=>{
                console.log(err)
            })
        }
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

app.get(
    '*',
    (req, res) => {
        res.sendFile(resolve('./client/build', 'index.html'))
    }
);

httpServer.listen(process.env.PORT, () => {
    console.log(`@ listening on *:${process.env.PORT} >>>`);
});