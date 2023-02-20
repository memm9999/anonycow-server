-- DropForeignKey
ALTER TABLE "Process" DROP CONSTRAINT "Process_userId_fkey";

-- AlterTable
ALTER TABLE "Process" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Process" ADD CONSTRAINT "Process_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
