#!/usr/bin/env node
import bcrypt from "bcrypt";
import yargs from 'yargs';
import {PrismaClient} from "@prisma/client";
import {hideBin} from "yargs/helpers";

const prisma = new PrismaClient();

const options = yargs(hideBin(process.argv))
    .option("u", { alias: "username", describe: "The admin username", type: "string", demandOption: true })
    .option("p", { alias: "password", describe: "The admin password", type: "string", demandOption: true })
    .argv;

(async ()=>{
    await prisma.admin.create({
        data: {
            username: options.username,
            password: await bcrypt.hash(options.password, await bcrypt.genSalt()),
        }
    })
})()

console.log(">>> Hello, World! <<<")