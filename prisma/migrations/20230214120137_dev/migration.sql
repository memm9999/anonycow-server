/*
  Warnings:

  - You are about to drop the column `adminId` on the `FortuneItem` table. All the data in the column will be lost.
  - Made the column `userId` on table `FortuneItem` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "FortuneItem" DROP CONSTRAINT "FortuneItem_adminId_fkey";

-- DropForeignKey
ALTER TABLE "FortuneItem" DROP CONSTRAINT "FortuneItem_userId_fkey";

-- DropForeignKey
ALTER TABLE "Process" DROP CONSTRAINT "Process_userId_fkey";

-- AlterTable
ALTER TABLE "FortuneItem" DROP COLUMN "adminId",
ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Process" ADD COLUMN     "adminId" INTEGER,
ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Process" ADD CONSTRAINT "Process_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Process" ADD CONSTRAINT "Process_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortuneItem" ADD CONSTRAINT "FortuneItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
