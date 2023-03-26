export default {
    T: (manager, user, times) => {
        manager.ioUpdateUser(
            user.id,
            {
                balance: Math.round(user.balance * times)
            }
        ).then(
            _user => {
                manager.saveProcessRecord(
                    "pts:modify",
                    [
                        {user: _user.id},
                        {
                            data: [user.balance, _user.balance]
                        }
                    ]
                )
        })
    },
    S: (manager, user, n) => {
        manager.ioUpdateUser(
            user.id,
            {
                spins: Math.round(user.spins + n)
            }
        ).then(
            _user => {
                manager.saveProcessRecord(
                    "spins:modify",
                    [
                        {user: _user.id},
                        {
                            data: [user.spins, _user.spins]
                        }
                    ]
                )
        })
    },
    B: (manager, user, pts) => {
        manager.ioUpdateUser(
            user.id,
            {
                balance: Math.round(user.balance + pts)
            }
        ).then(
            _user => {
                manager.saveProcessRecord(
                    "pts:modify",
                    [
                        {user: _user.id},
                        {
                            data: [user.balance, _user.balance]
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