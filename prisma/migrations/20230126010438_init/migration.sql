/*
  Warnings:

  - Made the column `userId` on table `Process` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Process" DROP CONSTRAINT "Process_userId_fkey";

-- AlterTable
ALTER TABLE "Process" ALTER COLUMN "userId" SET NOT NULL,
ALTER COLUMN "userId" SET DEFAULT 'anonymous';

-- AddForeignKey
ALTER TABLE "Process" ADD CONSTRAINT "Process_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
