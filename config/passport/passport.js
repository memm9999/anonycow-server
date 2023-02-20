import { Strategy } from 'passport-local'
import passport from "passport";
import {PrismaClient} from "@prisma/client";
import bcrypt from "bcrypt";
export default (passport) => {

    const prisma = new PrismaClient();

    passport.use(
        new Strategy({
            usernameField: "username",
            passwordField: "password"
        }, async (username, password, cb) => {

            const admin = await prisma.admin.findUnique({
                where: {
                    username: username
                }
            })

            if (admin) {

                if(await bcrypt.compare(password, admin.password)) {
                    return cb(null, admin);
                } else {
                    return cb(null, false, {message: 'Incorrect username or password.'});
                }

            } else {
                return cb(null, false, {message: 'Incorrect username or password.'});
            }

        })
    );

}