-- CreateEnum
CREATE TYPE "FortuneClass" AS ENUM ('T', 'S', 'J', 'N');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "spins" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FortuneItem" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "class" "FortuneClass" NOT NULL,
    "arguments" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "FortuneItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FortuneItem" ADD CONSTRAINT "FortuneItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
