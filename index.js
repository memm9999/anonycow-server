import express from "express";
import {createServer} from "http";
import {Server} from "socket.io";
import session from "express-session";
import got from "got";
import {Buffer} from "node:buffer"
import cors from "cors"
import {instrument} from "@socket.io/admin-ui";
import {PrismaClient} from "@prisma/client";
import passport from "passport";
import passportConfig from "./config/passport/passport.js";
import {SessionManager, FRONTEND_USER_KEYS} from "./controllers/manager.js";
import Queue from 'bull';

passportConfig(passport);

const CLIENT_ID = "SGxZZ2VuTmpPUGJKTmUxMFo2dUI6MTpjaQ"
const CLIENT_SECRET = "YbMQYf-_HfZP2mhEVvlJVgq3AB2ZdTGpYRsbgA-ksUz63i6swj"
const PORT = 5000
const FORTUNE_DISCOUNT = 1000
const FORTUNE_DICTIONARY = {
    T: async (manager, user, times) => {
        await manager.ioUpdateUser(
            user.id,
            {
                balance: user.balance * times
            }
        ).then(user => {
            manager.saveProcessRecord(
                "pts:modify",
                [
                    {user: user.id},
                    user.balance * times
                ]
            )
        })
    },
    S: async (manager, user, n) => {
        await manager.ioUpdateUser(
            user.id,
            {
                spins: user.spins + n
            }
        ).then(user => {
            manager.saveProcessRecord(
                "spins:modify",
                [
                    {user: user.id},
                    user.spins + n
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

const sessionMiddleware = session({
    secret: 'secret',
    saveUninitialized: false,
    resave: false
})

const prisma = new PrismaClient();

SessionManager.init(prisma)

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
    const session = socket.request.session
    if (session.userLoggedIn && session.userId) {
        socket.join(session.userId)
    }
    next()
})

instrument(io, {
    auth: false,
    mode: "development",
});

const timerQueue = new Queue('timer')
const timerProcessor = (manager) => async (job, done) => {
    const selectedUserId = job.data.selectedUserId
    const currentTime = job.opts.repeat.limit - job.opts.repeat.count
    // console.log(`>>> ${job.id} <> ${currentTime}`)

    if (currentTime <= 0) {
        await manager.ioUpdateUser(
            selectedUserId,
            {
                timerPreserved: false,
                timerLastDuration: 0,
                timerId: null
            }
        ).then(
            async (user) => {
                manager.io.to(selectedUserId).emit('timer:end')
                await manager.saveProcessRecord(
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
            },
            true
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
        passport.authenticate('local', {failureRedirect: req.query?.to || "/admin"}, (err, admin, info) => {
            req.session.admin = admin ? SessionManager._specifyKeys(['id', 'username'])(admin) : undefined
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

    const manager = new SessionManager(prisma, io, req.session)

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

        let userDetailed = await manager.getUser(user.data.id, {
            fortuneItems: true
        })

        if (!userDetailed) {
            userDetailed = await manager.createUser(
                {
                    id: user.data.id,
                    name: user.data.name,
                    username: user.data.username,
                    avatar: user.data.profile_image_url

                }, {
                    fortuneItems: true
                }
            )

            await manager.saveProcessRecord(
                "user:create",
                [{user: user.data.id}, user.data]
            )
        }

        await manager.saveProcessRecord(
            "user:login",
            [{user: user.data.id}, user.data]
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

        // await manager.updateInSession("userLoggedIn", true)
        // await manager.updateInSession("user", userDetailed)

        manager.updateInSession({
            userId: userDetailed.id,
            userLoggedIn: true
        }).then(
            (session) => {
                manager.ioBroadcastUser(userDetailed.id, userDetailed)
            }
        )

        res.redirect("/")

    } catch (e) {
        console.log(e)
        res.redirect("/")
        // res.send("Something is going wrong please try again")
    }
});

io.on('connection', async (socket) => {
    const manager = new SessionManager(prisma, io, socket.request.session, socket)

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

    await manager.ioAdminOn('admin:get', async () => [
        {
            admin: manager.session?.admin?.id
        },
        {
            admin: manager.session?.admin,
            handshake: manager.socket.handshake
        }
    ])

    await manager.ioAdminOn('admin:select', async (username) => {
        const selectedUser = await manager.getUserByUsername(
            username, {
                fortuneItems: true
            }
        )

        await manager.updateInSession({
            selectedUserId: selectedUser?.id
        }).then(
            (session) => {
                manager.ioBroadcastUser(manager.socket.id, selectedUser, {
                    'admin:select': SessionManager._broadcastUserEvents(manager)['admin:select']
                })
            }
        )



        if (selectedUser) {

            await timerQueue.process(manager.socket.id, timerProcessor(manager))

            manager.socket.rooms.forEach((roomId) => {
                manager.socket.leave(roomId)
                // if (roomId !== socket.id) {
                //     console.log(roomId)
                //     manager.socket.leave(roomId)
                // }
            })

            manager.socket.join(selectedUser?.id)

            return [
                {
                    admin: manager.session?.admin?.id,
                    user: selectedUser?.id
                }
            ]
        }

    })

    await manager.ioAdminOn('pts:modify', async (pts) => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

        let newBalance;

        if (user) {
            newBalance = user.balance + parseInt(pts)

            await manager.ioUpdateUser(
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
                [newBalance, pts]
            ]
        }

    })

    await manager.ioAdminOn('pts:confirm', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

        let newBalance;

        if (user) {
            newBalance = user.balance - user.withdraw

            await manager.ioUpdateUser(
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
                [newBalance, user.withdraw]
            ]
        }

    })

    await manager.ioAdminOn('spins:modify', async (spins) => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

        let newSpins;

        if (user) {
            newSpins = user.spins + parseInt(spins)

            await manager.ioUpdateUser(
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
                [newSpins, spins]
            ]
        }

    })

    await manager.ioAdminOn('fortune:edit', async (fortuneItems) => {

    })

    /*
    * >>> timer controls for admin functionality <<<
    * */

    await manager.ioAdminOn('timer:set', async (duration) => {
        if (manager?.session?.selectedUserId) {

            await manager.ioUpdateUser(
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
                duration
            ]
        }
    })

    await manager.ioAdminOn('timer:start', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)
        const timerJob = await timerQueue.add(
            manager.socket.id,
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
            await manager.ioUpdateUser(
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
            user.timerLastDuration
        ]

    })

    await manager.ioAdminOn('timer:pause', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

        if (user?.timerId) {
            await timerQueue.removeRepeatableByKey(user.timerId)

            await manager.ioUpdateUser(
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
                user.timerLastDuration
            ]
        }

    })

    await manager.ioAdminOn('timer:end', async () => {
        const user = await manager.getUser(manager?.session?.selectedUserId)

        if (user?.timerId) {
            await timerQueue.removeRepeatableByKey(user.timerId)

            await manager.ioUpdateUser(
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

    await manager.ioOn('user:get', () => {
        // console.log(manager.session?.userId)

        manager.ioBroadcastUser()

        return [
            {
                user: manager.session?.userId
            }
        ]
    })

    /*
    * >>> vcn add-edit functionality <<<
    * */

    await manager.ioOn('vcn:add', (number) => {
        if (manager.session?.userId) {
            manager.io.to(manager.session?.userId).emit('vcn:verify', number)
            return [
                {
                    user: manager.session?.userId
                },
                number
            ]
        }
    })

    await manager.ioOn('vcn:save', (number) => {
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
                number
            ]
        }
    })

    /*
    * >>> fortune wheel functionality <<<
    * */

    await manager.ioOn('fortune:spin', async (number) => {
        const user = await manager.getUser(manager.session?.userId)

        manager.io.to(manager.session?.userId).emit('fortune:spin', +!user.spins * FORTUNE_DISCOUNT)

        return [
            {
                user: user.id
            },
            [user.balance, user.spins]
        ]
    })

    await manager.ioOn('fortune:confirm', async (number) => {
        const user = await manager.getUser(manager.session?.userId, {
            fortuneItems: true
        })
        const fortuneDiscount = +!Math.max(user.spins, 0) * FORTUNE_DISCOUNT

        let winningItem;

        if (user.balance >= fortuneDiscount) {
            await manager.ioUpdateUser(
                user.id,
                {
                    spins: Math.max(user.spins - 1, 0),
                    balance: Math.max(user.balance - fortuneDiscount, 0)
                }
            ).then(user => {
                winningItem = user.fortuneItems[Math.floor(Math.random() * user.fortuneItems.length)]
                setTimeout(async () => {
                    await FORTUNE_DICTIONARY[winningItem.class](manager, user, winningItem.arguments)
                }, 5000)
                manager.io.to(user.id).emit('fortune:confirm', winningItem.id)
            })

            return [
                {
                    user: user.id
                },
                winningItem
            ]
        }

        // manager.io.to(user.id).emit('user:get')

        return []
    })

    /*
    * >>> timer controls for user functionality <<<
    * */

    await manager.ioOn('timer:ready', async (ready) => {
        if (manager.session?.userId) {
            await manager.ioUpdateUser(
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

    await manager.ioOn('pts:withdraw', async (pts) => {
        const prevWithdraw = manager.session?.user?.withdraw

        await manager.ioUpdateUser(
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
            pts
        ]

    })

    await manager.saveProcessRecord(
        "client:log",
        [
            {user: manager.session?.userId || SessionManager._initUserId},
            socket.handshake
        ]
    )

    console.log(`💻 ${socket.id} connected >>>`);
});

httpServer.listen(PORT, () => {
    console.log('listening on *:5000');
});