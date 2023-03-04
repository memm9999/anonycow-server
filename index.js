import express from "express";
import {createServer} from "http";
import {Server, Socket} from "socket.io";
import session, {Session} from "express-session";
import got from "got";
import {Buffer} from "node:buffer"
import cors from "cors"
import {instrument} from "@socket.io/admin-ui";
import {PrismaClient} from "@prisma/client";
import passport from "passport";
import passportConfig from "./config/passport/passport.js";
import {SessionManager, FRONTEND_USER_KEYS} from "./controllers/manager.js";
import Queue from 'bull';
import crypto from "crypto";
import redis from "redis";
import connectRedis from "connect-redis";


passportConfig(passport);

const CLIENT_ID = "SGxZZ2VuTmpPUGJKTmUxMFo2dUI6MTpjaQ"
const CLIENT_SECRET = "YbMQYf-_HfZP2mhEVvlJVgq3AB2ZdTGpYRsbgA-ksUz63i6swj"
const PORT = 5000
const FORTUNE_DISCOUNT = 1000
const FORTUNE_DICTIONARY = {
    T: (manager, user, times) => {
        manager.ioUpdateUser(
            user.id,
            {
                balance: user.balance * times
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
                spins: user.spins + n
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

const app = express();
const httpServer = createServer(app);
const RedisStore = connectRedis(session)
const redisClient = redis.createClient({
    legacyMode: true
})

await redisClient.connect()

redisClient.on('error', function (err) {
    console.log('Could not establish a connection with redis. ' + err);
});
redisClient.on('connect', function (err) {
    console.log('Connected to redis successfully');
});

const sessionMiddleware = session({
    secret: 'secret',
    saveUninitialized: false,
    resave: false,
    // unset: 'keep',
    // cookie: { secure: false }
    store: new RedisStore({ client: redisClient })
})

const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));

app.use(sessionMiddleware);
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

const io = new Server(httpServer, {
    cors: {
        origin: ["http://127.0.0.1:3000", "https://admin.socket.io"],
        credentials: true
    }
});

io.use(wrap(sessionMiddleware));

io.use((socket, next) => {
    // const manager = new SessionManager(prisma, io, socket.request.session)
    const session = socket.request.session

    console.log(session)

    if (session.userLoggedIn && session.userId) {
        socket.join(session.userId)
    }
    next()
})

instrument(io, {
    auth: false,
    mode: "development",
});

SessionManager.init(prisma, app, io)

const timerQueue = new Queue('timer')
const timerProcessor = (manager) => (job, done) => {
    const selectedUserId = job.data.selectedUserId
    const currentTime = job.opts.repeat.limit - job.opts.repeat.count
    // console.log(`>>> ${job.id} <> ${currentTime}`)

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
                            admin: manager.session?.admin?.id,
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
            }
        ).then(
            (user) => {
                manager.io.to(selectedUserId).emit('timer:current', currentTime)
            }
        )
    }

    done()
}

app.post(
    '/api/admin/auth',
    (req, res, next) => {
        passport.authenticate('local', {failureRedirect: req.query?.to || "/admin"}, async (err, admin, info) => {
            const manager = new SessionManager(prisma, io)

            await manager.updateInSession(
                {
                    admin: admin ? SessionManager._specifyKeys(['id', 'username'])(admin) : undefined
                },
                req.query?.to || "/admin",
                res
            )
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

    const manager = new SessionManager(prisma, io, req.session)

    console.log('>>> Accessing /api/auth <<<')

    try {
        const data = await got.post('https://api.twitter.com/2/oauth2/token', {
            headers: {
                'Authorization': `Basic ${Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString('base64')}`
            },
            json: {
                'code': req.query.code,
                'grant_type': 'authorization_code',
                'client_id': CLIENT_ID,
                'redirect_uri': `${req.protocol}://${req.hostname}:3000${req.path}`,
                'code_verifier': 'challenge'
            }
        }).json();

        const user = await got.get('https://api.twitter.com/2/users/me', {
            searchParams: {
                'user.fields': 'id,username,name,profile_image_url'
            },
            headers: {
                'Authorization': `Bearer ${data.access_token}`
            }
        }).json()

        let userDetailed = await manager.getUser(user.data.id)

        if (!userDetailed) {
            userDetailed = await manager.createUser(
                {
                    id: user.data.id,
                    name: user.data.name,
                    username: user.data.username,
                    avatar: user.data.profile_image_url

                }
            )

            manager.saveProcessRecord(
                "user:create",
                [
                    {
                        user: user.data.id
                    }
                ]
            )
        }

        manager.saveProcessRecord(
            "user:login",
            [
                {
                    user: user.data.id
                }
            ]
        )

        const twitterToken = await manager.createData(
            prisma.twitterToken, {
                tokenType: data.token_type,
                expiresIn: data.expires_in,
                accessToken: data.access_token,
                scope: data.scope,
                refreshToken: data.refresh_token,
                user: {
                    connect: {
                        id: user.data.id
                    }
                }
            }
        )

        await manager.updateInSession(
            {
                userId: userDetailed.id,
                userLoggedIn: true
            },
            null,
            res
        )

    } catch (e) {
        console.log(e)
    }

    // res.redirect("/")
});

io.on('connection', (socket) => {
    // socket.once()
    // socket.use(([event, ...args], next) => {
    //     // socket.emit('reopen')
    //     socket.request.session.save(()=>{
    //         socket.request.session.name = "anonymous"
    //
    //         socket.request.session.reload(()=>{
    //             console.log(socket.request.session)
    //         })
    //     })
    //     next();
    // });

    const manager = new SessionManager(prisma, io, socket)
    // console.log(manager.session)

    // console.log(manager.session)

    // if(!(manager.session?.userId && manager.session?.userLoggedIn)) {
    //     manager.updateInSession({
    //         userId: null,
    //         userLoggedIn: false
    //     })
    // }

    manager.ioOn('disconnect', () => {
        manager.socket.rooms.forEach((roomId) => {
            manager.socket.leave(roomId)
            if (manager.socket.id) {
                // console.log(roomId)
                manager.socket.leave(roomId)
            }
        })

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

    manager.ioAdminOn('admin:get', () => [
        {
            admin: manager.session?.admin?.id
        },
        {
            data: {
                admin: manager.session?.admin,
                handshake: manager.socket.handshake
            }
        }
    ])

    manager.ioAdminOn('admin:select', async (username) => {
        // console.log(manager.session)

        const selectedUser = await manager.getUserByUsername(
            username
        )

        const _process = manager.updateInSession(
            {
                selectedUserId: selectedUser?.id
            }
        ).then(
            (pinId) => {

                if (selectedUser) {
                    try {
                        timerQueue.process(selectedUser.id, timerProcessor(manager))
                    } catch (e) {
                    }

                    manager.socket.rooms.forEach((roomId) => {
                        if (roomId !== manager.socket.id) {
                            manager.socket.leave(roomId)
                        }
                    })

                    manager.socket.join(selectedUser?.id)

                    manager.ioBroadcastUser(selectedUser?.id, selectedUser, {
                        'admin:select': SessionManager._broadcastUserEvents['admin:select'],
                        'activities:count': SessionManager._broadcastUserEvents['activities:count']
                    })

                    return Promise.resolve([
                        {
                            admin: manager.session?.admin?.id,
                            user: selectedUser?.id
                        }
                    ])
                }
            }
        )

        return _process

    })

    manager.ioAdminOn('pts:modify', async (pts) => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                    admin: manager.session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newBalance, pts]
                }
            ]
        }

    })

    manager.ioAdminOn('pts:confirm', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                    admin: manager.session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newBalance, user.withdraw]
                }
            ]
        }

    })

    manager.ioAdminOn('spins:modify', async (spins) => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                    admin: manager.session?.admin?.id,
                    user: user.id
                },
                {
                    data: [newSpins, spins]
                }
            ]
        }

    })

    manager.ioAdminOn('fortune:edit', async (order) => {

        let deletedItems = []

        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                admin: manager.session?.admin?.id,
                user: user.id
            },
            {
                data: outOrder
            }
        ]

    })

    manager.ioAdminOn('fortune:add', async (fortuneItem) => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                admin: manager.session?.admin?.id,
                user: user?.id
            },
            {
                data: newFortuneItem
            }
        ]
    })

    manager.ioAdminOn('fortune:prizes', () => {
        manager.io.to(manager.session?.selectedUserId).emit('fortune:prizes', Object.keys(FORTUNE_DICTIONARY))
        return [
            {
                admin: manager.session?.admin?.id
            }
        ]
    })

    manager.ioAdminOn('activities:list', async (filter, page) => {
        // console.log(filter)
        // console.log(manager.session)

        if (filter && filter !== manager?.session?.activitiesFilter) {
            // console.log(">>> changing activitiesFilter <<<")
            await manager.updateInSession(
                {
                    activitiesFilter: filter
                }
            )
        }

        const activitiesCount = await manager.prisma.process.count({
            where: {
                class: {
                    in: filter || manager.session?.activitiesFilter
                },
                userId: {
                    equals: manager.session?.selectedUserId
                }
            }
        })

        // console.log(activitiesCount)

        const activities = await manager.prisma.process.findMany({
            where: {
                class: {
                    in: filter || manager.session?.activitiesFilter
                },
                userId: {
                    equals: manager.session?.selectedUserId
                }
            },
            skip: page * 50,
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

        // console.log(activities)

        // console.log(manager.session)

        manager.io.to(manager.session?.selectedUserId).emit('activities:list', {
            activities: activities,
            count: activitiesCount
        })

        return [
            {
                admin: manager.session?.admin?.id
            }
        ]
    })

    /*
    * >>> timer controls for admin functionality <<<
    * */

    manager.ioAdminOn('timer:set', async (duration) => {
        if (manager?.session?.selectedUserId) {

            manager.ioUpdateUser(
                manager?.session?.selectedUserId,
                {
                    timerLastDuration: duration,
                    ready: false
                }
            )

            manager.io.to(manager?.session?.selectedUserId).emit('timer:set', duration)

            return [
                {
                    admin: manager.session?.admin?.id,
                    user: manager?.session?.selectedUserId
                },
                {
                    data: duration
                }
            ]

        }
    })

    manager.ioAdminOn('timer:start', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)
        const timerJob = await timerQueue.add(
            user.id,
            {
                selectedUserId: user.id
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
                admin: manager.session?.admin?.id,
                user: user?.id
            },
            {
                data: user.timerLastDuration
            }
        ]

    })

    manager.ioAdminOn('timer:pause', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                    admin: manager.session?.admin?.id,
                    user: user?.id
                },
                {
                    data: user.timerLastDuration
                }
            ]
        }

    })

    manager.ioAdminOn('timer:end', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

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
                    admin: manager.session?.admin?.id,
                    user: user?.id
                }
            ]
        }

    })

    /*
    * >>> user refresh functionality <<<
    * */

    manager.ioOn('user:get', () => {
        // console.log(manager.session?.userId)
        // console.log(manager.socket instanceof Socket, manager.socket.request.session instanceof Session)

        manager.ioBroadcastUser(
            manager.session?.userId,
            null,
            {
                'user:get': SessionManager._broadcastUserEvents['user:get'],
                // 'admin:select': SessionManager._broadcastUserEvents['admin:select']
            }
        )

        return [
            {
                user: manager.session?.userId
            }
        ]
    })

    /*
    * >>> vcn add-edit functionality <<<
    * */

    manager.ioOn('vcn:add', (number) => {
        if (manager.session?.userId) {
            manager.io.to(manager.session?.userId).emit('vcn:verify', number)
            return [
                {
                    user: manager.session?.userId
                },
                {
                    data: number
                }
            ]
        }
    })

    manager.ioOn('vcn:save', (number) => {
        if (manager.session?.userId) {
            manager.ioUpdateUser(
                manager.session?.userId,
                {
                    vcn: number
                }
            )
            manager.io.to(manager.session?.userId).emit('vcn:save', number)
            return [
                {
                    user: manager.session?.userId
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

    manager.ioOn('fortune:spin', async (number) => {
        const user = await manager.getUser(manager.session?.userId)

        manager.io.to(manager.session?.userId).emit('fortune:spin', +!user.spins * FORTUNE_DISCOUNT)

        return [
            {
                user: user.id
            },
            {
                data: [user.balance, user.spins]
            }
        ]
    })

    manager.ioOn('fortune:confirm', async (number) => {
        const user = await manager.getUser(manager.session?.userId)
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

    manager.ioOn('timer:ready', (ready) => {
        if (manager.session?.userId) {
            manager.ioUpdateUser(
                manager.session?.userId,
                {
                    ready: ready
                }
            )

            return [
                {user: manager.session?.userId}
            ]
        }
    })

    /*
    * >>> Pts withdraw for user functionality <<<
    * */

    manager.ioOn('pts:withdraw', (pts) => {
        const prevWithdraw = manager.session?.user?.withdraw

        manager.ioUpdateUser(
            manager.session?.userId,
            {
                withdraw: pts
            }
        ).then(
            (user) => {
                manager.io.to(user.id).emit('pts:withdraw', user.withdraw, prevWithdraw)
            }
        )

        return [
            {user: manager.session?.userId},
            {
                data: pts
            }
        ]

    })

    manager.saveProcessRecord(
        "client:log",
        [
            {user: manager.session?.userId || SessionManager._initUserId},
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